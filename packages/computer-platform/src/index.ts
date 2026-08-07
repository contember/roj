/**
 * Platform adapter backed by a `@cloudflare/computer` Workspace.
 *
 * Lets `@roj-ai/sdk` run inside a Durable Object with the workspace's
 * SQLite-backed virtual filesystem in place of a host filesystem.
 */

import type { Workspace } from '@cloudflare/computer'
import type { GitClient as ComputerGitClient } from '@cloudflare/computer/git'
import type { Platform } from '@roj-ai/sdk/platform'
import { createComputerFileSystem } from './fs.js'
import { createComputerGitClient } from './git.js'
import { createShellProcessRunner, createUnsupportedProcessRunner } from './process.js'

export interface ComputerPlatformOptions {
	/** Directory used for scratch files. Created lazily by callers, like `os.tmpdir()` on a host. */
	tmpDir?: string
}

export function createComputerPlatform(workspace: Workspace, options: ComputerPlatformOptions = {}): Platform {
	const git = workspaceGit(workspace)
	return {
		fs: createComputerFileSystem(workspace.provider()),
		process: createUnsupportedProcessRunner(),
		git: git && createComputerGitClient(git),
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
export type { ShellProcessRunnerOptions } from './process.js'
export { SqliteEventStore } from './sqlite-event-store.js'
export type { SqlCursorLike, SqlStorageHost, SqlStorageLike } from './sqlite-event-store.js'
