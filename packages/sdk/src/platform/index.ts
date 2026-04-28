/**
 * Platform adapters — runtime-agnostic interfaces for host-environment capabilities.
 *
 * Code in `@roj-ai/sdk` MUST NOT import from `node:*` / `bun:*` directly;
 * it goes through these adapters. Concrete implementations are provided by
 * runtime packages (e.g. `@roj-ai/sdk/bun-platform`) and wired in at bootstrap time.
 */

import type { FileSystem } from './fs.js'
import type { ProcessRunner } from './process.js'

export type { Dirent, FileHandle, FileSystem, Stats } from './fs.js'
export type { ChildProcess, ExecFileOptions, ExecFileResult, ProcessRunner, SpawnOptions } from './process.js'

/**
 * Aggregate platform capabilities passed through the system at bootstrap.
 */
export interface Platform {
	fs: FileSystem
	process: ProcessRunner
	/** Absolute path to the OS temp directory (equivalent to `os.tmpdir()` on Node/Bun). */
	tmpDir: string
}
