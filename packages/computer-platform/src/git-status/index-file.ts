/**
 * `.git/index`, read for the two things a status needs: what git has staged for
 * each path, and how big that path was when it did.
 *
 * The index is the baseline that makes a native status possible at all. It says
 * what every tracked path *should* look like, git maintains it across `add`,
 * `commit`, `checkout` and `clone`, and it survives everything the isolate does
 * not — so nothing has to be seeded, persisted or carried across a wake.
 *
 * Only version 2 is read. That is the only version isomorphic-git writes or
 * accepts, and isomorphic-git is what writes this file inside the isolate; a
 * v3/v4 index, an extended flag or an unmerged path is left to the git binding
 * rather than guessed at.
 */

/** 'DIRC'. */
const SIGNATURE = 0x44495243
const SUPPORTED_VERSION = 2
const HEADER_BYTES = 12
/** Fixed part of an entry: two timestamps, six stat fields, the oid, the flags. */
const ENTRY_FIXED_BYTES = 62
/** SHA-1 of everything before it. */
const TRAILER_BYTES = 20
const OID_BYTES = 20

const STAGE_MASK = 0x3000
const EXTENDED_FLAG = 0x4000
const GITLINK_MODE = 0o160000

const decoder = new TextDecoder()

export interface GitIndexEntry {
	path: string
	oid: string
	/** Working-tree size git recorded when the entry was written. */
	size: number
	/**
	 * Working-tree mtime git recorded with it, in ms — the stat cache. A file
	 * whose size and mtime still match these has not been written since, which is
	 * how a status stays off the file content of every clean path in the tree.
	 */
	mtimeMs: number
	/** Normalised git mode — 0o100644, 0o100755 or 0o120000. */
	mode: number
}

function hex(bytes: Uint8Array, offset: number, length: number): string {
	let out = ''
	for (let i = 0; i < length; i++) {
		const byte = bytes[offset + i]
		if (byte === undefined) return ''
		out += byte.toString(16).padStart(2, '0')
	}
	return out
}

/** Entries by path, or `undefined` for anything this reader will not vouch for. */
export function parseGitIndex(bytes: Uint8Array): Map<string, GitIndexEntry> | undefined {
	if (bytes.byteLength < HEADER_BYTES + TRAILER_BYTES) return undefined

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (view.getUint32(0) !== SIGNATURE) return undefined
	if (view.getUint32(4) !== SUPPORTED_VERSION) return undefined

	const count = view.getUint32(8)
	const limit = bytes.byteLength - TRAILER_BYTES
	const entries = new Map<string, GitIndexEntry>()
	let offset = HEADER_BYTES

	for (let index = 0; index < count; index++) {
		if (offset + ENTRY_FIXED_BYTES > limit) return undefined

		// Seconds and nanoseconds, which is how the stat that produced them was split.
		const mtimeMs = view.getUint32(offset + 8) * 1000 + view.getUint32(offset + 12) / 1e6
		const mode = view.getUint32(offset + 24)
		const size = view.getUint32(offset + 36)
		const oid = hex(bytes, offset + 40, OID_BYTES)
		const flags = view.getUint16(offset + 60)
		// An unmerged path has three entries and a status this reader cannot express;
		// an extended flag means a v3 shape it did not parse.
		if ((flags & STAGE_MASK) !== 0 || (flags & EXTENDED_FLAG) !== 0) return undefined
		// A submodule's "content" is another repository, which is not ours to compare.
		if (mode === GITLINK_MODE) return undefined

		const pathStart = offset + ENTRY_FIXED_BYTES
		const nul = bytes.indexOf(0, pathStart)
		if (nul <= pathStart || nul > limit || oid === '') return undefined
		const path = decoder.decode(bytes.subarray(pathStart, nul))
		entries.set(path, { path, oid, size, mtimeMs, mode })

		// Entries are NUL-padded so that each one starts 8-aligned against the end of
		// the header — 1 to 8 bytes, never none.
		offset = nul + (8 - ((nul - HEADER_BYTES) % 8))
	}

	return entries
}
