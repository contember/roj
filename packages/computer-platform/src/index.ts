/**
 * Platform adapter backed by a `@cloudflare/computer` Workspace.
 *
 * Lets `@roj-ai/sdk` run inside a Durable Object with the workspace's
 * SQLite-backed virtual filesystem in place of a host filesystem.
 */

import type { Workspace } from '@cloudflare/computer'
import type { Platform } from '@roj-ai/sdk/platform'
import { createComputerFileSystem } from './fs.js'
import { createUnsupportedProcessRunner } from './process.js'

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

export { createComputerFileSystem, createUnsupportedProcessRunner }
