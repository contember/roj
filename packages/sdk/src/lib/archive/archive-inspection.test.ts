import { describe, expect, test } from 'bun:test'
import type { ProcessRunner } from '~/platform/process.js'
import {
	DEFAULT_ARCHIVE_LIMITS,
	inspectZipArchive,
	parseZipInfoVerbose,
	validateArchiveEntries,
	type ArchiveEntry,
} from './archive-inspection.js'
import {
	BACKSLASH_INFO_ZIP_6_FIXTURE,
	DOS_INFO_ZIP_6_FIXTURE,
	EMPTY_INFO_ZIP_6_FIXTURE,
	SAFE_INFO_ZIP_6_FIXTURE,
	SYMLINK_INFO_ZIP_6_FIXTURE,
	TRUNCATED_INFO_ZIP_6_FIXTURE,
} from './archive-inspection.fixtures.js'

const MEBIBYTE = 1024 * 1024

function file(name: string, uncompressedSize = 0): ArchiveEntry {
	return { name, uncompressedSize, type: 'file' }
}

function directory(name: string): ArchiveEntry {
	return { name, uncompressedSize: 0, type: 'directory' }
}

describe('validateArchiveEntries', () => {
	test('accepts the exact entry count and total size boundaries', () => {
		const entries = Array.from({ length: 500 }, (_, index) => file(`nested/file-${index}.txt`, index === 0 ? 100 * MEBIBYTE : 0))

		const result = validateArchiveEntries(entries)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.value.entries).toHaveLength(DEFAULT_ARCHIVE_LIMITS.maxEntries)
		expect(result.value.totalUncompressedSize).toBe(DEFAULT_ARCHIVE_LIMITS.maxTotalUncompressedSize)
	})

	test('rejects 501 entries even when they are directories', () => {
		const result = validateArchiveEntries(Array.from({ length: 501 }, (_, index) => directory(`dir-${index}/`)))

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.code).toBe('too_many_entries')
	})

	test('rejects one byte over the total size limit', () => {
		const result = validateArchiveEntries([file('large.bin', 100 * MEBIBYTE + 1)])

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.code).toBe('too_large')
	})

	test('accepts nested files and counts directories separately', () => {
		const result = validateArchiveEntries([
			directory('nested/'),
			directory('nested/deeper/'),
			file('nested/deeper/file.txt', 12),
		])

		expect(result).toEqual({
			ok: true,
			value: {
				entries: [directory('nested/'), directory('nested/deeper/'), file('nested/deeper/file.txt', 12)],
				fileCount: 1,
				directoryCount: 2,
				totalUncompressedSize: 12,
			},
		})
	})

	test('rejects an empty archive', () => {
		const result = validateArchiveEntries([])

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.code).toBe('empty_archive')
	})

	test.each([
		['directory without slash', { name: 'dir', uncompressedSize: 0, type: 'directory' }],
		['non-empty directory', { name: 'dir/', uncompressedSize: 1, type: 'directory' }],
		['regular file with slash', { name: 'file/', uncompressedSize: 0, type: 'file' }],
	] satisfies ReadonlyArray<readonly [string, ArchiveEntry]>)('rejects inconsistent %s', (_label, entry) => {
		const result = validateArchiveEntries([entry])

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.code).toBe('unsupported_entry_type')
	})

	test.each([
		['absolute POSIX path', '/etc/passwd'],
		['absolute platform path', '\\server\\share'],
		['drive path', 'C:\\temp\\file'],
		['parent traversal', 'safe/../outside'],
		['platform-separator traversal', 'safe\\..\\outside'],
		['NUL byte', 'safe\0outside'],
	])('rejects %s', (_label, name) => {
		const result = validateArchiveEntries([file(name)])

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.code).toBe('unsafe_path')
		expect(result.error.entryName).toBe(name)
	})
})

describe('parseZipInfoVerbose', () => {
	test('parses captured regular, Unicode/space, and directory entries', () => {
		expect(parseZipInfoVerbose(SAFE_INFO_ZIP_6_FIXTURE)).toEqual({
			ok: true,
			value: [file('regular.txt', 1), file('space ž.txt', 7), directory('dir/')],
		})
	})

	test('parses captured MS-DOS regular and directory attributes', () => {
		expect(parseZipInfoVerbose(DOS_INFO_ZIP_6_FIXTURE)).toEqual({
			ok: true,
			value: [file('win-file.txt', 1), directory('win-dir/')],
		})
	})

	test('reports captured truncated CLI output explicitly', () => {
		const result = parseZipInfoVerbose(TRUNCATED_INFO_ZIP_6_FIXTURE)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.code).toBe('invalid_listing')
	})

	test('rejects a captured trailing-backslash regular file during validation', () => {
		const parsed = parseZipInfoVerbose(BACKSLASH_INFO_ZIP_6_FIXTURE)
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return

		const result = validateArchiveEntries(parsed.value)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.code).toBe('unsafe_path')
	})

	test('rejects a captured symlink entry', () => {
		const result = parseZipInfoVerbose(SYMLINK_INFO_ZIP_6_FIXTURE)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.code).toBe('unsupported_entry_type')
	})

	test.each([
		['FIFO', '010644'],
		['character device', '020666'],
		['block device', '060660'],
		['socket', '140777'],
	])('rejects a Unix %s entry', (_label, mode) => {
		const result = parseZipInfoVerbose(SYMLINK_INFO_ZIP_6_FIXTURE.replace('120777', mode))

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.code).toBe('unsupported_entry_type')
	})

	test('rejects a captured empty ZIP', () => {
		const result = parseZipInfoVerbose(EMPTY_INFO_ZIP_6_FIXTURE)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.code).toBe('empty_archive')
	})
})

describe('inspectZipArchive', () => {
	test('uses unzip listing mode and preserves timeout and cancellation', async () => {
		const controller = new AbortController()
		let receivedSignal: AbortSignal | undefined
		const process: ProcessRunner = {
			async execFile(command, args, options) {
				expect(command).toBe('unzip')
				expect(args).toEqual(['-Z', '-v', '/archive.zip'])
				expect(options?.timeout).toBe(1234)
				receivedSignal = options?.signal
				return { stdout: SAFE_INFO_ZIP_6_FIXTURE, stderr: '' }
			},
			spawn() {
				throw new Error('not used')
			},
		}

		const result = await inspectZipArchive(process, '/archive.zip', { signal: controller.signal, timeoutMs: 1234 })

		expect(result.ok).toBe(true)
		expect(receivedSignal).toBe(controller.signal)
	})

	test('fails closed when Info-ZIP reports a non-zero warning exit', async () => {
		const process: ProcessRunner = {
			async execFile() {
				throw new Error('unzip exited with code 1 after warnings')
			},
			spawn() {
				throw new Error('not used')
			},
		}

		const result = await inspectZipArchive(process, '/archive.zip')

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.code).toBe('command_failed')
	})

	test('propagates abort through ProcessRunner and reports it distinctly', async () => {
		const controller = new AbortController()
		const process: ProcessRunner = {
			async execFile(_command, _args, options) {
				expect(options?.signal).toBe(controller.signal)
				controller.abort(new Error('cancelled'))
				throw new Error('process aborted')
			},
			spawn() {
				throw new Error('not used')
			},
		}

		const result = await inspectZipArchive(process, '/archive.zip', { signal: controller.signal })

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.code).toBe('aborted')
		expect(result.error.cause).toBe(controller.signal.reason)
	})
})
