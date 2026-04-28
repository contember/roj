/**
 * Directory listing helpers.
 *
 * Extracted from HTTP routes for reuse in RPC methods.
 */

import { extname, join, resolve } from 'node:path'
import type { FileSystem } from '~/platform/fs.js'

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
 */
export function preventTraversal(baseDir: string, requestedPath: string): string | null {
	const resolved = resolve(baseDir, requestedPath)
	if (!resolved.startsWith(baseDir + '/') && resolved !== baseDir) {
		return null
	}
	return resolved
}

/**
 * List a single directory level, returning sorted DirectoryEntry[].
 * Directories first, then alphabetical within each group.
 */
export async function listDirectory(fs: FileSystem, baseDir: string, subPath: string): Promise<DirectoryEntry[]> {
	const targetDir = subPath ? preventTraversal(baseDir, subPath) : baseDir
	if (!targetDir) {
		throw new ListingError('forbidden', 'Path traversal not allowed')
	}

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

	// Sort: directories first, then alphabetical
	entries.sort((a, b) => {
		if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
		return a.name.localeCompare(b.name)
	})

	return entries
}

/**
 * Recursively list all entries under a directory.
 * Skips hidden files and IGNORED_DIRS.
 */
export async function listDirectoryRecursive(fs: FileSystem, baseDir: string): Promise<DirectoryEntry[]> {
	const entries: DirectoryEntry[] = []

	async function walk(dir: string, prefix: string) {
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

	await walk(baseDir, '')
	return entries
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
