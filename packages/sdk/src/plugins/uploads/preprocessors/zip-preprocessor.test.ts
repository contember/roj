import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import { ArchiveBudget } from '~/lib/archive/index.js'
import { SYMLINK_INFO_ZIP_6_FIXTURE } from '~/lib/archive/archive-inspection.fixtures.js'
import type { ProcessRunner } from '~/platform/process.js'
import { silentLogger } from '../../../lib/logger/logger.js'
import { createNodePlatform } from '../../../testing/node-platform.js'
import { PreprocessorRegistry } from '../preprocessor.js'
import { ZipPreprocessor } from './zip-preprocessor.js'

interface ListingEntry {
	name: string
	size: number
	type?: 'file' | 'directory'
}

function zipListing(entries: readonly ListingEntry[]): string {
	const noun = entries.length === 1 ? 'entry' : 'entries'
	const bodies = entries.map((entry, index) => {
		const type = entry.type ?? 'file'
		const mode = type === 'directory' ? '040775' : '100664'
		return `Central directory entry #${index + 1}:
---------------------------

  ${entry.name}

  file system or operating system of origin:      Unix
  uncompressed size:                              ${entry.size} bytes
  length of filename:                             ${new TextEncoder().encode(entry.name).byteLength} characters
  Unix file attributes (${mode} octal):            attributes
  MS-DOS file attributes (00 hex):                none
`
	})
	return `Archive: fixture.zip
  central directory contains ${entries.length} ${noun}.

${bodies.join('\n')}`
}

describe('ZipPreprocessor archive inspection', () => {
	const platform = createNodePlatform()
	let workDir: string

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'roj-zip-preprocessor-'))
	})

	afterEach(async () => {
		await rm(workDir, { recursive: true, force: true })
	})

	function createContext() {
		return {
			files: new SessionFileStore(workDir, undefined, false, platform.fs, 'session'),
		}
	}

	it.each([
		['parent traversal', zipListing([{ name: '../outside.txt', size: 1 }])],
		['backslash path', zipListing([{ name: 'dir\\outside.txt', size: 1 }])],
		['symlink', SYMLINK_INFO_ZIP_6_FIXTURE],
		[
			'entry limit',
			zipListing(
				Array.from({ length: 501 }, (_, index) => ({
					name: `file-${index}.txt`,
					size: 0,
				})),
			),
		],
		['size limit', zipListing([{ name: 'large.bin', size: 100 * 1024 * 1024 + 1 }])],
	])('rejects %s before extraction or derived writes', async (_label, listing) => {
		const calls: string[][] = []
		const process: ProcessRunner = {
			async execFile(command, args) {
				calls.push([command, ...args])
				return { stdout: listing, stderr: '' }
			},
			spawn() {
				throw new Error('not used')
			},
		}
		const preprocessor = new ZipPreprocessor({
			registry: new PreprocessorRegistry(),
			logger: silentLogger,
			process,
		})

		const result = await preprocessor.process('/unsafe.zip', 'application/zip', createContext())

		expect(result.ok).toBe(false)
		expect(calls).toEqual([['unzip', '-Z', '-v', '/unsafe.zip']])
		expect(await platform.fs.exists(join(workDir, 'extracted'))).toBe(false)
		expect(await platform.fs.exists(join(workDir, 'content.txt'))).toBe(false)
	})

	it('fails a warning from archive inspection without extracting', async () => {
		let callCount = 0
		const process: ProcessRunner = {
			async execFile() {
				callCount++
				throw new Error('unzip exited with code 1 after warnings')
			},
			spawn() {
				throw new Error('not used')
			},
		}
		const preprocessor = new ZipPreprocessor({
			registry: new PreprocessorRegistry(),
			logger: silentLogger,
			process,
		})

		const result = await preprocessor.process('/warning.zip', 'application/zip', createContext())

		expect(result.ok).toBe(false)
		expect(callCount).toBe(1)
		expect(await platform.fs.exists(join(workDir, 'extracted'))).toBe(false)
	})

	it('fails an extraction warning without listing or writing derived files', async () => {
		const calls: string[][] = []
		const process: ProcessRunner = {
			async execFile(command, args) {
				calls.push([command, ...args])
				if (args[0] === '-Z') {
					return { stdout: zipListing([{ name: 'safe.txt', size: 4 }]), stderr: '' }
				}
				throw new Error('unzip exited with code 1 after warnings')
			},
			spawn() {
				throw new Error('not used')
			},
		}
		const preprocessor = new ZipPreprocessor({
			registry: new PreprocessorRegistry(),
			logger: silentLogger,
			process,
		})

		const result = await preprocessor.process('/warning.zip', 'application/zip', createContext())

		expect(result.ok).toBe(false)
		expect(calls).toHaveLength(2)
		expect(calls[0]).toEqual(['unzip', '-Z', '-v', '/warning.zip'])
		expect(calls[1]?.slice(0, 4)).toEqual(['unzip', '-o', '-q', '/warning.zip'])
		expect(await platform.fs.exists(join(workDir, 'content.txt'))).toBe(false)
	})

	it('propagates an inspection abort without extracting', async () => {
		const controller = new AbortController()
		const reason = new Error('cancel inspection')
		let callCount = 0
		const process: ProcessRunner = {
			async execFile(_command, _args, options) {
				callCount++
				expect(options?.signal).toBe(controller.signal)
				controller.abort(reason)
				throw reason
			},
			spawn() {
				throw new Error('not used')
			},
		}
		const preprocessor = new ZipPreprocessor({
			registry: new PreprocessorRegistry(),
			logger: silentLogger,
			process,
		})

		const result = await preprocessor.process('/aborted.zip', 'application/zip', {
			...createContext(),
			signal: controller.signal,
		})

		expect(result).toEqual({ ok: false, error: reason })
		expect(callCount).toBe(1)
		expect(await platform.fs.exists(join(workDir, 'extracted'))).toBe(false)
	})

	it('does not extract when inspection resolves after aborting', async () => {
		const controller = new AbortController()
		const reason = new Error('cancel after listing')
		const calls: string[][] = []
		const process: ProcessRunner = {
			async execFile(command, args) {
				calls.push([command, ...args])
				controller.abort(reason)
				return { stdout: zipListing([{ name: 'safe.txt', size: 4 }]), stderr: '' }
			},
			spawn() {
				throw new Error('not used')
			},
		}
		const preprocessor = new ZipPreprocessor({
			registry: new PreprocessorRegistry(),
			logger: silentLogger,
			process,
		})

		const result = await preprocessor.process('/abort-after-listing.zip', 'application/zip', {
			...createContext(),
			signal: controller.signal,
		})

		expect(result).toEqual({ ok: false, error: reason })
		expect(calls).toEqual([['unzip', '-Z', '-v', '/abort-after-listing.zip']])
		expect(await platform.fs.exists(join(workDir, 'extracted'))).toBe(false)
	})

	it('inspects each nested archive before extracting that depth', async () => {
		const calls: string[] = []
		const process: ProcessRunner = {
			async execFile(command, args) {
				if (args[0] === '-Z') {
					const archivePath = args[args.length - 1]
					calls.push(`inspect:${archivePath}`)
					return archivePath.endsWith('nested.zip')
						? {
								stdout: zipListing([{ name: 'leaf.txt', size: 4 }]),
								stderr: '',
							}
						: {
								stdout: zipListing([{ name: 'nested.zip', size: 4 }]),
								stderr: '',
							}
				}

				const archivePath = args[2]
				const destination = args[args.indexOf('-d') + 1]
				calls.push(`extract:${archivePath}`)
				await mkdir(destination, { recursive: true })
				if (archivePath.endsWith('nested.zip')) {
					await writeFile(join(destination, 'leaf.txt'), 'leaf')
				} else {
					await writeFile(join(destination, 'nested.zip'), 'nested')
				}
				return { stdout: '', stderr: '' }
			},
			spawn() {
				throw new Error('not used')
			},
		}
		const preprocessor = new ZipPreprocessor({
			registry: new PreprocessorRegistry(),
			logger: silentLogger,
			process,
		})

		const result = await preprocessor.process('/outer.zip', 'application/zip', createContext())

		expect(result.ok).toBe(true)
		expect(calls).toEqual([
			'inspect:/outer.zip',
			'extract:/outer.zip',
			`inspect:${join(workDir, 'extracted/nested.zip')}`,
			`extract:${join(workDir, 'extracted/nested.zip')}`,
		])
	})

	it('shares one configured budget across nested archives', async () => {
		const calls: string[] = []
		const process: ProcessRunner = {
			async execFile(_command, args) {
				if (args[0] === '-Z') {
					const archivePath = args[args.length - 1]
					calls.push(`inspect:${archivePath}`)
					return archivePath.endsWith('nested.zip')
						? { stdout: zipListing([{ name: 'one.txt', size: 3 }, { name: 'two.txt', size: 3 }]), stderr: '' }
						: { stdout: zipListing([{ name: 'nested.zip', size: 4 }]), stderr: '' }
				}

				const archivePath = args[2]
				const destination = args[args.indexOf('-d') + 1]
				calls.push(`extract:${archivePath}`)
				await mkdir(destination, { recursive: true })
				await writeFile(join(destination, 'nested.zip'), 'nested')
				return { stdout: '', stderr: '' }
			},
			spawn() {
				throw new Error('not used')
			},
		}
		const preprocessor = new ZipPreprocessor({
			registry: new PreprocessorRegistry(),
			logger: silentLogger,
			process,
		})

		const result = await preprocessor.process('/outer.zip', 'application/zip', {
			...createContext(),
			archiveBudget: new ArchiveBudget({ maxEntries: 2, maxTotalUncompressedSize: 100 }),
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toContain('aggregate 2 entry limit')
		expect(calls).toEqual([
			'inspect:/outer.zip',
			'extract:/outer.zip',
			`inspect:${join(workDir, 'extracted/nested.zip')}`,
		])
	})
})
