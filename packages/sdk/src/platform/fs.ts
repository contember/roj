/**
 * FileSystem adapter interface.
 *
 * Platform-agnostic subset of `node:fs/promises` operations used across the SDK.
 * Concrete implementations live in runtime-specific packages (e.g. `@roj-ai/sdk/bun-platform`).
 */

import type { Dirent, Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

export type { Dirent, FileHandle, Stats }

/**
 * Positional-read handle — the subset of `node:fs/promises` FileHandle the SDK uses.
 *
 * Narrower than `FileHandle` so platforms without a full handle abstraction
 * (e.g. a VFS exposing only raw fds) can implement it. `FileHandle` satisfies it.
 */
export interface ReadableFileHandle {
	stat(): Promise<Stats>
	read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Buffer }>
	close(): Promise<void>
}

export interface FileSystem {
	readFile(path: string): Promise<Buffer>
	readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>

	writeFile(path: string, data: string | Uint8Array): Promise<void>
	appendFile(path: string, data: string | Uint8Array): Promise<void>

	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
	readdir(path: string): Promise<string[]>
	readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>

	stat(path: string): Promise<Stats>
	access(path: string, mode?: number): Promise<void>

	unlink(path: string): Promise<void>
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
	cp(source: string, dest: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>

	open(path: string, flags?: string): Promise<ReadableFileHandle>

	/** Returns true if path exists and is accessible; never throws for missing paths. */
	exists(path: string): Promise<boolean>

	/** Resolves symlinks and returns the canonical pathname. */
	realpath(path: string): Promise<string>

	/**
	 * Optional. Every entry under `dir`, with the metadata a stat would return.
	 *
	 * The verb a recursive listing wants. Walking with readdir and stat asks the
	 * platform one question per entry and gives it no way to see that they belong
	 * together; asking for the subtree does. A platform that can answer it whole
	 * does — one backed by a database reads the tree in a handful of statements
	 * instead of one per directory.
	 *
	 * Absent on a plain node:fs platform, where the walk below is what it would
	 * do anyway. Callers keep their own policy: `exclude` and `excludeHidden` are
	 * passed in so the walk can skip a subtree rather than return it for the
	 * caller to discard.
	 */
	walk?(dir: string, options?: WalkOptions): Promise<WalkEntry[]>

	/**
	 * Optional. Every byte of every path, asked for once.
	 *
	 * Same argument as `walk`, for files rather than directories: a caller
	 * reading a set of files one call at a time gives the platform no way to see
	 * that they belong together, and a store backed by a database answers the
	 * whole set in about as much work as it spends on one file.
	 *
	 * Reports per path instead of throwing, because a batch that threw on the
	 * first missing file would send the caller back to asking one at a time.
	 * Entries come back in the order they were asked for.
	 */
	readFiles?(paths: readonly string[]): Promise<ReadFilesEntry[]>

	/**
	 * Optional. Write a set of files as one operation.
	 *
	 * The other half of the same argument. A platform that batches its writes
	 * can only do so within one operation, and one call per file is one
	 * operation per file.
	 */
	writeFiles?(entries: readonly WriteFilesEntry[], options?: WriteFilesOptions): Promise<void>

	/**
	 * Optional. Run `fn` with reads served from a per-operation cache, where the
	 * platform has one.
	 *
	 * A hint and nothing more: the same calls return the same answers with or
	 * without it, so a caller may always skip it and a platform may leave it out.
	 * Prefer `walk` where it fits — a verb cannot be forgotten the way a wrapper
	 * can. This is for what no verb covers: reading, then writing, then reading
	 * again within one operation.
	 */
	scopeReads?<T>(fn: () => Promise<T>): Promise<T>
}

/** One entry under a walked directory. */
export interface WalkEntry {
	/** Absolute path. */
	path: string
	type: 'file' | 'directory' | 'symlink'
	/** Bytes for a file, 0 for a directory. */
	size: number
	mtime: number
}

/** One path's answer from `readFiles`, in the order it was asked for. */
export interface ReadFilesEntry {
	path: string
	/** The bytes, or absent when `error` says why there are none. */
	content?: Buffer
	/** The code `readFile` would have thrown for this path. */
	error?: string
}

export interface WriteFilesEntry {
	path: string
	content: string | Uint8Array
}

export interface WriteFilesOptions {
	/** Create the directories the entries need, as `mkdir -p` would. Off by default. */
	createParents?: boolean
}

export interface WalkOptions {
	/** Levels to descend. 1 is the directory's own children; unlimited when absent. */
	depth?: number
	/** Entries to return at most, in traversal order. */
	limit?: number
	/** Names never returned and, for a directory, never descended into. */
	exclude?: readonly string[]
	/** The same, for every name beginning with a dot. */
	excludeHidden?: boolean
}
