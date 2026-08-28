/**
 * Directory listing helpers.
 *
 * Extracted from HTTP routes for reuse in RPC methods.
 */

import { extname, join, resolve } from 'node:path'
import { containmentOf } from '~/core/file-store/containment.js'
import type { FileSystem, WalkEntry } from '~/platform/fs.js'

// ============================================================================
// Constants
// ============================================================================

/** Known MIME types for specific extensions. */
const MIME_TYPES: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.bmp': 'image/bmp',
	'.avif': 'image/avif',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mov': 'video/quicktime',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.pdf': 'application/pdf',
	'.json': 'application/json',
	'.html': 'text/html',
	'.css': 'text/css',
	'.js': 'application/javascript',
	'.mjs': 'application/javascript',
	'.xml': 'text/xml',
	'.yaml': 'text/yaml',
	'.yml': 'text/yaml',
	'.md': 'text/markdown',
	'.zip': 'application/zip',
	'.tar': 'application/x-tar',
	'.gz': 'application/gzip',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.wasm': 'application/wasm',
}

/** Extensions known to be binary — files that cannot be displayed as text. */
const BINARY_EXTENSIONS = new Set([
	'.jpg',
	'.jpeg',
	'.png',
	'.gif',
	'.webp',
	'.bmp',
	'.ico',
	'.tiff',
	'.tif',
	'.avif',
	'.mp4',
	'.webm',
	'.avi',
	'.mov',
	'.mkv',
	'.flv',
	'.wmv',
	'.mp3',
	'.wav',
	'.ogg',
	'.flac',
	'.aac',
	'.wma',
	'.m4a',
	'.zip',
	'.tar',
	'.gz',
	'.bz2',
	'.xz',
	'.7z',
	'.rar',
	'.zst',
	'.pdf',
	'.doc',
	'.docx',
	'.xls',
	'.xlsx',
	'.ppt',
	'.pptx',
	'.odt',
	'.woff',
	'.woff2',
	'.ttf',
	'.otf',
	'.eot',
	'.wasm',
	'.exe',
	'.dll',
	'.so',
	'.dylib',
	'.o',
	'.a',
	'.class',
	'.pyc',
	'.pyo',
	'.sqlite',
	'.db',
	'.sqlite3',
	'.bin',
	'.dat',
])

/** Directories to skip during recursive workspace listing. */
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.output', '.astro'])

// ============================================================================
// Types
// ============================================================================

export interface DirectoryEntry {
	name: string
	path?: string
	type: 'file' | 'directory'
	size: number
	mimeType?: string
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Determine MIME type for a file.
 * Known extensions get their specific MIME type, known binary extensions
 * get `application/octet-stream`, everything else defaults to `text/plain`.
 */
export function getMimeType(filePath: string): string {
	const ext = extname(filePath).toLowerCase()
	if (MIME_TYPES[ext]) return MIME_TYPES[ext]
	if (BINARY_EXTENSIONS.has(ext)) return 'application/octet-stream'
	return 'text/plain'
}

/**
 * Prevent path traversal — returns resolved path if safe, null otherwise.
 *
 * Lexical only. Callers that then touch the filesystem must also check the real
 * target with `containmentOf`.
 */
export function preventTraversal(baseDir: string, requestedPath: string): string | null {
	const resolved = resolve(baseDir, requestedPath)
	if (!resolved.startsWith(baseDir + '/') && resolved !== baseDir) {
		return null
	}
	return resolved
}

/** Path under `baseDir`, with the separator dropped. */
function relativeUnder(path: string, baseDir: string): string {
	return path.slice(baseDir.endsWith('/') ? baseDir.length : baseDir.length + 1)
}

/** A walked entry as this plugin reports it; `relativeTo` adds the `path` the recursive listing carries. */
function toDirectoryEntry(entry: WalkEntry, relativeTo?: string): DirectoryEntry {
	const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
	const isDir = entry.type === 'directory'
	const out: DirectoryEntry = {
		name,
		...(relativeTo === undefined ? {} : { path: relativeUnder(entry.path, relativeTo) }),
		type: isDir ? 'directory' : 'file',
		size: isDir ? 0 : entry.size,
	}
	if (!isDir) out.mimeType = getMimeType(name)
	return out
}

/** Directories first, then alphabetical — applied to whichever path produced the entries. */
function sortEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
	entries.sort((a, b) => {
		if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
		return a.name.localeCompare(b.name)
	})
	return entries
}

/**
 * List a single directory level, returning sorted DirectoryEntry[].
 * Directories first, then alphabetical within each group.
 */
export async function listDirectory(fs: FileSystem, baseDir: string, subPath: string): Promise<DirectoryEntry[]> {
	const targetDir = subPath ? preventTraversal(baseDir, subPath) : baseDir
	if (!targetDir || (await containmentOf(fs, [baseDir], targetDir)) !== 'inside') {
		throw new ListingError('forbidden', 'Path traversal not allowed')
	}

	if (fs.walk) {
		let found: WalkEntry[]
		try {
			found = await fs.walk(targetDir, { depth: 1, excludeHidden: true })
		} catch {
			throw new ListingError('not_found', 'Directory not found')
		}
		return sortEntries(found.map((entry) => toDirectoryEntry(entry)))
	}

	// The readdir and a stat per entry are one question asked in pieces, so let a
	// platform that can share those reads see them as one.
	const read = (): Promise<DirectoryEntry[]> => readLevel(fs, targetDir)
	return fs.scopeReads ? fs.scopeReads(read) : read()
}

async function readLevel(fs: FileSystem, targetDir: string): Promise<DirectoryEntry[]> {
	let dirents: import('node:fs').Dirent[]
	try {
		dirents = await fs.readdir(targetDir, { withFileTypes: true })
	} catch {
		throw new ListingError('not_found', 'Directory not found')
	}

	const entries: DirectoryEntry[] = []
	for (const dirent of dirents) {
		if (dirent.name.startsWith('.')) continue

		const entryPath = join(targetDir, dirent.name)
		const isDir = dirent.isDirectory()

		let size = 0
		if (!isDir) {
			try {
				const st = await fs.stat(entryPath)
				size = st.size
			} catch {
				continue
			}
		}

		const entry: DirectoryEntry = {
			name: dirent.name,
			type: isDir ? 'directory' : 'file',
			size,
		}
		if (!isDir) {
			entry.mimeType = getMimeType(dirent.name)
		}
		entries.push(entry)
	}

	return sortEntries(entries)
}

/**
 * Recursively list all entries under a directory.
 * Skips hidden files and IGNORED_DIRS.
 */
export async function listDirectoryRecursive(fs: FileSystem, baseDir: string): Promise<DirectoryEntry[]> {
	if (fs.walk) {
		try {
			const found = await fs.walk(baseDir, { exclude: [...IGNORED_DIRS], excludeHidden: true })
			return found.map((entry) => toDirectoryEntry(entry, baseDir))
		} catch {
			// The loop below answers an unreadable directory with an empty listing, not a throw.
			return []
		}
	}

	const entries: DirectoryEntry[] = []

	async function walk(dir: string, prefix: string): Promise<void> {
		let dirents: import('node:fs').Dirent[]
		try {
			dirents = await fs.readdir(dir, { withFileTypes: true })
		} catch {
			return
		}

		for (const dirent of dirents) {
			if (dirent.name.startsWith('.')) continue
			if (IGNORED_DIRS.has(dirent.name)) continue

			const entryPath = join(dir, dirent.name)
			const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name
			const isDir = dirent.isDirectory()

			let size = 0
			if (!isDir) {
				try {
					const st = await fs.stat(entryPath)
					size = st.size
				} catch {
					continue
				}
			}

			const entry: DirectoryEntry = {
				name: dirent.name,
				path: relativePath,
				type: isDir ? 'directory' : 'file',
				size,
			}
			if (!isDir) {
				entry.mimeType = getMimeType(dirent.name)
			}
			entries.push(entry)

			if (isDir) {
				await walk(entryPath, relativePath)
			}
		}
	}

	// Every stat here follows a readdir the level above already read past, so a
	// platform that can share those reads should be given the chance to.
	const run = async (): Promise<DirectoryEntry[]> => {
		await walk(baseDir, '')
		return entries
	}
	return fs.scopeReads ? fs.scopeReads(run) : run()
}

// ============================================================================
// Error
// ============================================================================

export class ListingError extends Error {
	constructor(
		public readonly type: 'forbidden' | 'not_found',
		message: string,
	) {
		super(message)
	}
}
