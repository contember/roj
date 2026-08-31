/**
 * Platform adapters — runtime-agnostic interfaces for host-environment capabilities.
 *
 * Code in `@roj-ai/sdk` MUST NOT import from `node:*` / `bun:*` directly;
 * it goes through these adapters. Concrete implementations are provided by
 * runtime packages (e.g. `@roj-ai/sdk/bun-platform`) and wired in at bootstrap time.
 */

import type { FileSystem } from './fs.js'
import type { FsRevision } from './fs-revision.js'
import type { GitClient } from './git.js'
import type { LLMCallStore } from './llm-call-log.js'
import type { ProcessRunner } from './process.js'
import type { Scheduler } from './scheduler.js'
import type { SessionLogStore } from './session-log.js'
import type { ShellRunner } from './shell.js'

export type {
	Dirent,
	FileHandle,
	FileSystem,
	ReadableFileHandle,
	ReadFilesEntry,
	Stats,
	WalkEntry,
	WalkOptions,
	WriteFilesEntry,
	WriteFilesOptions,
} from './fs.js'
export type { FsRevision } from './fs-revision.js'
export type { GitClient, GitCommit, GitCountAheadOptions, GitLogOptions, GitRepoOptions, GitStatusEntry } from './git.js'
export type { LLMCallOutcome, LLMCallPage, LLMCallRow, LLMCallStatus, LLMCallStore } from './llm-call-log.js'
export type { ChildProcess, ExecFileOptions, ExecFileResult, ProcessRunner, SpawnOptions } from './process.js'
export { createTimerScheduler, isLiveScheduler } from './scheduler.js'
export type { LiveScheduler, Scheduler, WakeHandler } from './scheduler.js'
export type { SessionLogPage, SessionLogStore } from './session-log.js'
export type { ShellConfinement, ShellGrant, ShellLimits, ShellRunner, ShellRunOptions, ShellRunResult } from './shell.js'

/**
 * Aggregate platform capabilities passed through the system at bootstrap.
 *
 * `fs`, `process` and `scheduler` are required — every host has them, even if a
 * process table is only a stub. The rest are optional: a host that omits one is
 * not degraded, it is a host whose callers take the path they took before the
 * port existed.
 */
export interface Platform {
	fs: FileSystem
	process: ProcessRunner
	/** Delayed re-entry into the agent loop. Required: every host can schedule. */
	scheduler: Scheduler
	/** Runs the shell tool's command lines. Absent on a host with no shell at all. */
	shell?: ShellRunner
	/** Git over the host's repositories. Absent on hosts that cannot run git. */
	git?: GitClient
	/**
	 * Cheap "has the filesystem changed" counter. Absent on hosts that cannot
	 * answer it, which then recompute whatever they would have gated on.
	 */
	fsRevision?: FsRevision
	/**
	 * Rows for the per-session log. Absent on hosts with real files, which keep
	 * writing `sessions/<id>/session.log` and cursoring it by byte offset.
	 */
	sessionLog?: SessionLogStore
	/**
	 * Rows for the LLM call log. Absent on hosts with real files, which keep
	 * writing `sessions/<id>/calls/<callId>.json` and listing that directory.
	 */
	llmCallLog?: LLMCallStore
	/** Absolute path to the OS temp directory (equivalent to `os.tmpdir()` on Node/Bun). */
	tmpDir: string
}
