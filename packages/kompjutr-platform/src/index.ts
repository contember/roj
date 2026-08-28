/**
 * Platform adapter backed by a kompjutr workspace.
 *
 * Lets `@roj-ai/sdk` run against a filesystem and git runtime that are SQLite
 * rows rather than files on a disk — inside a Durable Object, or anywhere else
 * that can hand kompjutr a SQL storage.
 */

import type { Platform, Scheduler } from '@roj-ai/sdk/platform'
import { createTimerScheduler } from '@roj-ai/sdk/platform'
import type { Workspace } from 'kompjutr'
import { createKompjutrFileSystem } from './fs.js'
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

	return {
		fs: createKompjutrFileSystem({ compat: workspace.fs, filesystem: workspace.filesystem }),
		process: createUnsupportedProcessRunner(),
		scheduler: options.scheduler ?? createTimerScheduler(),
		tmpDir,
	}
}

export { createKompjutrFileSystem } from './fs.js'
export type { KompjutrFileSystemOptions } from './fs.js'
export { createUnsupportedProcessRunner } from './process.js'
