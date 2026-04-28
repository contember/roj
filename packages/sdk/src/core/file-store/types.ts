/**
 * FileStore interface for centralized file operations.
 * All paths are relative to the store's root directory.
 * Used by tools, lib functions, and the LLM provider.
 */

import type { Result } from '~/lib/utils/result.js'

export interface FileStat {
	size: number
	isFile: boolean
	isDirectory: boolean
}

export interface FileEntry {
	name: string
	type: 'file' | 'directory' | 'symlink' | 'other'
	size?: number
}

export interface FileStore {
	/** Write text or binary content. Auto-creates parent dirs. Returns the agent-visible path. */
	write(path: string, content: string | Buffer): Promise<Result<{ path: string }, string>>

	/** Read file as UTF-8 text. */
	read(path: string): Promise<Result<string, string>>
	/** Read file as Buffer. */
	read(path: string, opts: { type: 'buffer' }): Promise<Result<Buffer, string>>

	/** Check if a file exists. */
	exists(path: string): Promise<Result<boolean, string>>

	/** Get file/directory stats. */
	stat(path: string): Promise<Result<FileEntry, string>>

	/** List entries in a directory with type and size info. */
	list(path: string, options?: { maxDepth?: number; gitIgnore?: boolean }): Promise<Result<FileEntry[], string>>

	/** Remove a file. */
	remove(path: string): Promise<Result<void, string>>

	/** Resolve an agent-visible path to real filesystem path. */
	realPath(path: string): Result<string, string>

	/** Get the agent-visible root paths (virtual when sandboxed, real otherwise) */
	getRoots(): { session: string; workspace?: string }

	scoped(subPath: string): FileStore

	session: FileStore
	workspace?: FileStore
}
