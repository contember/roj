/**
 * Platform adapter backed by a kompjutr workspace.
 *
 * Lets `@roj-ai/sdk` run against a filesystem and git runtime that are SQLite
 * rows rather than files on a disk — inside a Durable Object, or anywhere else
 * that can hand kompjutr a SQL storage.
 */

import type { Platform, Scheduler } from '@roj-ai/sdk/platform'
import { createTimerScheduler } from '@roj-ai/sdk/platform'
import type { Git, Workspace } from 'kompjutr'
import { createKompjutrFileSystem } from './fs.js'
import { createKompjutrGitClient } from './git.js'
import { createUnsupportedProcessRunner } from './process.js'

export interface KompjutrPlatformOptions {
	/** Scratch directory, created if it is not there. Defaults to `/tmp`. */
	tmpDir?: string
	/**
	 * Drives the agent loop's re-entry. Defaults to timers, which is correct
	 * while the process lives and lost when it does not. A Durable Object passes
	 * an alarm-backed scheduler so a wake survives its isolate.
	 */
	scheduler?: Scheduler
}

export function createKompjutrPlatform(workspace: Workspace, options: KompjutrPlatformOptions = {}): Platform {
	const tmpDir = options.tmpDir ?? '/tmp'
	// A fresh workspace holds only `/`, and the port promises tmpDir is there.
	workspace.filesystem.mkdir(tmpDir, { recursive: true })

	const git = workspaceGit(workspace)

	return {
		fs: createKompjutrFileSystem({ compat: workspace.fs, filesystem: workspace.filesystem }),
		process: createUnsupportedProcessRunner(),
		git: git && createKompjutrGitClient(git),
		scheduler: options.scheduler ?? createTimerScheduler(),
		tmpDir,
	}
}

/** The getter throws unless `WorkspaceOptions.git` was set — the only signal a workspace gives. */
function workspaceGit(workspace: Workspace): Git | undefined {
	try {
		return workspace.git
	} catch {
		return undefined
	}
}

export { createKompjutrFileSystem } from './fs.js'
export type { KompjutrFileSystemOptions } from './fs.js'
export { createKompjutrGitClient } from './git.js'
export { createUnsupportedProcessRunner } from './process.js'
