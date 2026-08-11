import { describe, expect, test } from 'bun:test'
import { parseGitIndex } from './index-file.js'

/**
 * A real `.git/index`, written by git itself.
 *
 * Seven entries whose name lengths cover every padding remainder, plus a
 * symlink, an executable, and a TREE extension after the entries — so the
 * fixture pins the reader against a real writer rather than against a matching
 * misunderstanding in a hand-rolled encoder.
 */
const FIXTURE =
	'RElSQwAAAAIAAAAHantQEC+2kxNqe1AQL7aTEwAAADIBBkwtAACBpAAAA+gAAAPoAAAABkpYAHBSpl+8L8P5EPKFX0WkBY50AAFhAGp7UBAvtpMTantQEC+2kxMAAAAyAQZMLgAAgaQAAAPoAAAD6AAAAAVlst+H99867t7wS+lnA+VawZws+wACYWIAAAAAAAAAAGp7UBAvtpMTantQEC+2kxMAAAAyAQZMLwAAgaQAAAPoAAAD6AAAAAavF/bMh+TV5K3sABjLtz0+K9AIyAADYWJjAAAAAAAAAGp7UBAvtpMTantQEC+2kxMAAAAyAQZMMAAAgaQAAAPoAAAD6AAAAAarE17v6m9zuSHH/sRptfDp24a5EAAEYWJjZAAAAAAAAGp7UBAv66ZvantQEC/rpm8AAAAyAQZMMwAAoAAAAAPoAAAD6AAAACsQurDngNviB/y3JeISFYnu1ePaSgAEbGluawAAAAAAAGp7UBAvzSIUantQEC+2kxMAAAAyAQZMMgAAge0AAAPoAAAD6AAAABJBYwNu+mW9SkaedSJnSY8B6jalXAAGcnVuLnNoAAAAAGp7UBAvtpMTantQEC+2kxMAAAAyAQZMMQAAgaQAAAPoAAAD6AAAAAgVMPx69fzhmOxO8/E5lD+1tJH/1AArc3JjL2RlZXAvbmVzdGVkL2ZpbGUtd2l0aC1hLWxvbmdlci1uYW1lLnR4dAAAAAAAAABUUkVFAAAAcQA3IDEKxW7oQTLy3tajlq10TL5eDgMacMxzcmMAMSAxCvrwL5e33WCJr20pMrnYwVVsN4ZEZGVlcAAxIDEKBd9EpKeI8hKUS6Qq53cT5UFGCDpuZXN0ZWQAMSAwCl8pciCNF8FBmEAzYfNDFp2Zzrs/hbN7ZVLEGvAdN5EZZNfbh1fh/eM='

function fixture(): Uint8Array {
	return Uint8Array.from(Buffer.from(FIXTURE, 'base64'))
}

/** A copy with `patch` applied, so each rejection case starts from a valid file. */
function damaged(patch: (bytes: Uint8Array, view: DataView) => void): Uint8Array {
	const bytes = fixture()
	patch(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength))
	return bytes
}

/** Byte offset of the first entry's fixed part. */
const FIRST_ENTRY = 12

describe('parseGitIndex', () => {
	test('reads every entry git wrote', () => {
		const entries = parseGitIndex(fixture())
		expect([...entries?.keys() ?? []]).toEqual([
			'a',
			'ab',
			'abc',
			'abcd',
			'link',
			'run.sh',
			'src/deep/nested/file-with-a-longer-name.txt',
		])
	})

	test('reads the blob oid and working-tree size of an entry', () => {
		const entry = parseGitIndex(fixture())?.get('a')
		expect(entry?.oid).toBe('4a58007052a65fbc2fc3f910f2855f45a4058e74')
		expect(entry?.size).toBe(6)
	})

	// Padding is 1-8 bytes and depends on the name length, so a wrong formula
	// desynchronises everything after the first entry rather than failing loudly.
	test('stays aligned across every name length', () => {
		const entries = parseGitIndex(fixture())
		expect(entries?.get('abcd')?.oid).toBe('ab135eefea6f73b921c7fec469b5f0e9db86b910')
		expect(entries?.get('src/deep/nested/file-with-a-longer-name.txt')?.oid)
			.toBe('1530fc7af5fce198ec4ef3f139943fb5b491ffd4')
	})

	test('keeps the mode apart for a symlink and an executable', () => {
		const entries = parseGitIndex(fixture())
		expect(entries?.get('link')?.mode).toBe(0o120000)
		expect(entries?.get('run.sh')?.mode).toBe(0o100755)
		expect(entries?.get('a')?.mode).toBe(0o100644)
	})

	test('reads the stat cache mtime in milliseconds', () => {
		const bytes = fixture()
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		const mtimeMs = parseGitIndex(bytes)?.get('a')?.mtimeMs ?? 0
		// Both halves have to be combined: git stores seconds and nanoseconds apart,
		// and a reader that took only the seconds would call every edit clean for
		// the rest of that second.
		expect(Math.floor(mtimeMs / 1000)).toBe(view.getUint32(FIRST_ENTRY + 8))
		// Whole milliseconds, which is all the workspace filesystem ever records;
		// this fixture came off a real one, so it carries sub-millisecond digits
		// that a double cannot hold alongside an epoch in milliseconds.
		expect(mtimeMs % 1000).toBeCloseTo(view.getUint32(FIRST_ENTRY + 12) / 1e6, 3)
	})

	test('ignores the extensions that follow the entries', () => {
		// The fixture carries a TREE extension; reading past the entry count would
		// try to parse it as an eighth entry.
		expect(parseGitIndex(fixture())?.size).toBe(7)
	})

	test('refuses a version it has not read', () => {
		expect(parseGitIndex(damaged((_, view) => view.setUint32(4, 3)))).toBeUndefined()
	})

	test('refuses an unmerged path', () => {
		expect(parseGitIndex(damaged((_, view) => view.setUint16(FIRST_ENTRY + 60, 0x1001)))).toBeUndefined()
	})

	test('refuses an entry carrying extended flags', () => {
		expect(parseGitIndex(damaged((_, view) => view.setUint16(FIRST_ENTRY + 60, 0x4001)))).toBeUndefined()
	})

	test('refuses a submodule, whose content is another repository', () => {
		expect(parseGitIndex(damaged((_, view) => view.setUint32(FIRST_ENTRY + 24, 0o160000)))).toBeUndefined()
	})

	test('refuses something that is not an index at all', () => {
		expect(parseGitIndex(new Uint8Array(64))).toBeUndefined()
		expect(parseGitIndex(new Uint8Array(0))).toBeUndefined()
	})

	test('refuses a truncated file rather than reading past its end', () => {
		expect(parseGitIndex(fixture().subarray(0, 200))).toBeUndefined()
	})
})
