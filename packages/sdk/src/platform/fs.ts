/**
 * FileSystem adapter interface.
 *
 * Platform-agnostic subset of `node:fs/promises` operations used across the SDK.
 * Concrete implementations live in runtime-specific packages (e.g. `@roj-ai/sdk/bun-platform`).
 */

import type { Dirent, Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

export type { Dirent, FileHandle, Stats }

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

	open(path: string, flags?: string): Promise<FileHandle>

	/** Returns true if path exists and is accessible; never throws for missing paths. */
	exists(path: string): Promise<boolean>

	/** Resolves symlinks and returns the canonical pathname. */
	realpath(path: string): Promise<string>
}
