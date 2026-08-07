/**
 * FileSystem adapter over `@cloudflare/computer`'s `SQLiteWorkspaceProvider`.
 *
 * The provider is already node:fs-shaped, so most methods forward directly.
 * Four gaps are filled here: `appendFile` and `copyFile` reject with ENOSYS
 * upstream, and `rm -r` / `cp -r` have no provider equivalent at all.
 */

import type { SQLiteWorkspaceProvider } from '@cloudflare/computer'
import type { FileSystem, ReadableFileHandle, Stats } from '@roj-ai/sdk/platform'

/** node:fs errors carry `.code`; the provider follows the same convention. */
function errorCode(error: unknown): string | undefined {
	if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
	return undefined
}

function toBuffer(data: string | Uint8Array): Buffer {
	if (typeof data === 'string') return Buffer.from(data, 'utf-8')
	if (Buffer.isBuffer(data)) return data
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

/** The provider's readFile is encoding-polymorphic; split it into the two shapes the SDK expects. */
async function readFileBytes(provider: SQLiteWorkspaceProvider, path: string): Promise<Buffer> {
	const result = await provider.readFile(path)
	if (typeof result === 'string') throw new Error(`readFile(${path}) returned a string without an encoding`)
	return result
}

async function readFileText(provider: SQLiteWorkspaceProvider, path: string): Promise<string> {
	const result = await provider.readFile(path, 'utf-8')
	if (typeof result !== 'string') return result.toString('utf-8')
	return result
}

async function lstatOrNull(provider: SQLiteWorkspaceProvider, path: string): Promise<Stats | null> {
	try {
		return await provider.lstat(path)
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return null
		throw error
	}
}

async function readdirNames(provider: SQLiteWorkspaceProvider, path: string): Promise<string[]> {
	const entries = await provider.readdir(path)
	return entries.map((entry) => (typeof entry === 'string' ? entry : entry.name))
}

async function removeRecursive(provider: SQLiteWorkspaceProvider, path: string, stats: Stats): Promise<void> {
	if (!stats.isDirectory()) {
		await provider.unlink(path)
		return
	}
	for (const name of await readdirNames(provider, path)) {
		const child = `${path}/${name}`
		const childStats = await lstatOrNull(provider, child)
		if (childStats) await removeRecursive(provider, child, childStats)
	}
	await provider.rmdir(path)
}

async function copyRecursive(provider: SQLiteWorkspaceProvider, source: string, dest: string, stats: Stats): Promise<void> {
	if (stats.isSymbolicLink()) {
		await provider.symlink(await provider.readlink(source), dest)
		return
	}
	if (!stats.isDirectory()) {
		await provider.writeFile(dest, await readFileBytes(provider, source))
		return
	}
	await provider.mkdir(dest, { recursive: true })
	for (const name of await readdirNames(provider, source)) {
		const childStats = await lstatOrNull(provider, `${source}/${name}`)
		if (childStats) await copyRecursive(provider, `${source}/${name}`, `${dest}/${name}`, childStats)
	}
}

export function createComputerFileSystem(provider: SQLiteWorkspaceProvider): FileSystem {
	return {
		readFile: ((path: string, encoding?: 'utf-8' | 'utf8') =>
			encoding ? readFileText(provider, path) : readFileBytes(provider, path)) as FileSystem['readFile'],

		writeFile: (path, data) => provider.writeFile(path, toBuffer(data)),

		// Upstream appendFile rejects with ENOSYS; write at the current end instead.
		appendFile: async (path, data) => {
			const stats = await lstatOrNull(provider, path)
			if (!stats) {
				await provider.writeFile(path, toBuffer(data))
				return
			}
			provider.writeRangeSync(path, toBuffer(data), stats.size)
		},

		mkdir: async (path, options) => {
			await provider.mkdir(path, options)
		},

		readdir: ((path: string, options?: { withFileTypes: true }) =>
			options?.withFileTypes
				? provider.readdir(path, { withFileTypes: true })
				: readdirNames(provider, path)) as FileSystem['readdir'],

		stat: (path) => provider.stat(path),
		access: (path, mode) => provider.access(path, mode),

		unlink: (path) => provider.unlink(path),

		rm: async (path, options) => {
			const stats = await lstatOrNull(provider, path)
			if (!stats) {
				if (options?.force) return
				throw Object.assign(new Error(`no such file or directory: ${path}`), { code: 'ENOENT', path })
			}
			if (stats.isDirectory() && !options?.recursive) {
				await provider.rmdir(path)
				return
			}
			await removeRecursive(provider, path, stats)
		},

		cp: async (source, dest, options) => {
			const stats = await lstatOrNull(provider, source)
			if (!stats) throw Object.assign(new Error(`no such file or directory: ${source}`), { code: 'ENOENT', path: source })
			if (stats.isDirectory() && !options?.recursive) {
				throw Object.assign(new Error(`is a directory: ${source}`), { code: 'EISDIR', path: source })
			}
			await copyRecursive(provider, source, dest, stats)
		},

		// The provider exposes raw fds, not handles; wrap one in the read subset the SDK uses.
		open: async (path, flags): Promise<ReadableFileHandle> => {
			const fd = await provider.open(path, flags ?? 'r')
			return {
				stat: async () => provider.fstatSync(fd),
				read: async (buffer, offset, length, position) => ({
					bytesRead: provider.readSync(fd, buffer, offset, length, position),
					buffer,
				}),
				close: async () => provider.closeSync(fd),
			}
		},

		exists: (path) => provider.exists(path),
		realpath: (path) => provider.realpath(path),
	}
}
