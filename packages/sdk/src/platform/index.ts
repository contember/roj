/**
 * Platform adapters — runtime-agnostic interfaces for host-environment capabilities.
 *
 * Code in `@roj-ai/sdk` MUST NOT import from `node:*` / `bun:*` directly;
 * it goes through these adapters. Concrete implementations are provided by
 * runtime packages (e.g. `@roj-ai/sdk/bun-platform`) and wired in at bootstrap time.
 */

import type { FileSystem } from './fs.js'
import type { GitClient } from './git.js'
import type { ProcessRunner } from './process.js'
import type { Scheduler } from './scheduler.js'

export type { Dirent, FileHandle, FileSystem, ReadableFileHandle, Stats } from './fs.js'
export type { GitClient, GitCommit, GitCountAheadOptions, GitLogOptions, GitRepoOptions, GitStatusEntry } from './git.js'
export type { ChildProcess, ExecFileOptions, ExecFileResult, ProcessRunner, SpawnOptions } from './process.js'
export { createTimerScheduler, isLiveScheduler } from './scheduler.js'
export type { LiveScheduler, Scheduler, WakeHandler } from './scheduler.js'

/**
 * Aggregate platform capabilities passed through the system at bootstrap.
 */
export interface Platform {
	fs: FileSystem
	process: ProcessRunner
	/** Git over the host's repositories. Absent on hosts that cannot run git at all. */
	git?: GitClient
	/** Delayed re-entry into the agent loop. Required: every host can schedule. */
	scheduler: Scheduler
	/** Absolute path to the OS temp directory (equivalent to `os.tmpdir()` on Node/Bun). */
	tmpDir: string
}
