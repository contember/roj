/**
 * Platform adapter backed by a `@cloudflare/computer` Workspace.
 *
 * Lets `@roj-ai/sdk` run inside a Durable Object with the workspace's
 * SQLite-backed virtual filesystem in place of a host filesystem.
 */

import type { Workspace } from '@cloudflare/computer'
import type { GitClient as ComputerGitClient } from '@cloudflare/computer/git'
import { createTimerScheduler } from '@roj-ai/sdk/platform'
import type { Platform, Scheduler } from '@roj-ai/sdk/platform'
import { createComputerFileSystem } from './fs.js'
import { createVfsRevision } from './fs-revision.js'
import { createComputerGitClient } from './git.js'
import { createShellProcessRunner, createUnsupportedProcessRunner } from './process.js'

export interface ComputerPlatformOptions {
	/** Directory used for scratch files. Created lazily by callers, like `os.tmpdir()` on a host. */
	tmpDir?: string
	/**
	 * Drives the agent loop's re-entry. Defaults to timers, which is what the SDK
	 * did before the port existed — correct while the isolate lives, and lost when
	 * it is evicted. A DO that wants wakes to survive passes an alarm-backed one.
	 */
	scheduler?: Scheduler
}

export function createComputerPlatform(workspace: Workspace, options: ComputerPlatformOptions = {}): Platform {
	const git = workspaceGit(workspace)
	return {
		fs: createComputerFileSystem(workspace.provider()),
		process: createUnsupportedProcessRunner(),
		git: git && createComputerGitClient(git),
		// Whole-DO counter, so it is a gate against unnecessary reads, not a scope.
		fsRevision: createVfsRevision(workspace.db),
		scheduler: options.scheduler ?? createTimerScheduler(),
		tmpDir: options.tmpDir ?? '/tmp',
	}
}

/** The getter throws unless `WorkspaceOptions.git` was set — the only signal a Workspace gives. */
function workspaceGit(workspace: Workspace): ComputerGitClient | undefined {
	try {
		return workspace.git
	} catch {
		return undefined
	}
}

export { createComputerFileSystem, createComputerGitClient, createShellProcessRunner, createUnsupportedProcessRunner }
export { createVfsRevision, type VfsRevisionSource } from './fs-revision.js'
export { createSessionReaper, type ReapableEventStore, type ReapableFileSystem, type ReapableLLMCallLog, type ReapableSessionLog, type ReapedSession, type ReapOptions, type ReapReport, type ReapSkipped, type SessionReaper, type SessionReaperOptions } from './session-reaper.js'
export { createAlarmScheduler } from './alarm-scheduler.js'
export type {
	AlarmScheduler,
	AlarmSchedulerHost,
	AlarmSchedulerStats,
	AlarmStorageLike,
	SyncKvLike,
} from './alarm-scheduler.js'
export type { ShellProcessRunnerOptions } from './process.js'
export { SqliteEventStore } from './sqlite-event-store.js'
export type { SqlCursorLike, SqlStorageHost, SqlStorageLike } from './sqlite-event-store.js'
export { SqliteSessionLog } from './sqlite-session-log.js'
export { SqliteLLMCallLog, type SqliteLLMCallLogOptions } from './sqlite-llm-call-log.js'
