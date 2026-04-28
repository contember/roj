/**
 * Bun/Node platform adapter factory.
 *
 * Provides concrete implementations of `@roj-ai/sdk`'s Platform interface
 * using `node:fs/promises`, `node:child_process`, and `node:os`.
 */

import { tmpdir } from 'node:os'
import type { Platform } from '../platform/index.js'
import { createBunFileSystem } from './fs.js'
import { createBunProcessRunner } from './process.js'

export function createBunPlatform(): Platform {
	return {
		fs: createBunFileSystem(),
		process: createBunProcessRunner(),
		tmpDir: tmpdir(),
	}
}

export { createBunFileSystem, createBunProcessRunner }
