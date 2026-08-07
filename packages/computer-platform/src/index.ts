/**
 * Platform adapter backed by a `@cloudflare/computer` Workspace.
 *
 * Lets `@roj-ai/sdk` run inside a Durable Object with the workspace's
 * SQLite-backed virtual filesystem in place of a host filesystem.
 */

import type { Workspace } from '@cloudflare/computer'
import type { Platform } from '@roj-ai/sdk/platform'
import { createComputerFileSystem } from './fs.js'
import { createShellProcessRunner, createUnsupportedProcessRunner } from './process.js'

export interface ComputerPlatformOptions {
	/** Directory used for scratch files. Created lazily by callers, like `os.tmpdir()` on a host. */
	tmpDir?: string
}

export function createComputerPlatform(workspace: Workspace, options: ComputerPlatformOptions = {}): Platform {
	return {
		fs: createComputerFileSystem(workspace.provider()),
		process: createUnsupportedProcessRunner(),
		tmpDir: options.tmpDir ?? '/tmp',
	}
}

export { createComputerFileSystem, createShellProcessRunner, createUnsupportedProcessRunner }
export type { ShellProcessRunnerOptions } from './process.js'
export { SqliteEventStore } from './sqlite-event-store.js'
export type { SqlCursorLike, SqlStorageHost, SqlStorageLike } from './sqlite-event-store.js'
