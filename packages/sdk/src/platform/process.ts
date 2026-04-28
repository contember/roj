/**
 * ProcessRunner adapter interface.
 *
 * Platform-agnostic subset of `node:child_process` used across the SDK.
 * Concrete implementations live in runtime-specific packages (e.g. `@roj-ai/sdk/bun-platform`).
 */

import type { ChildProcess, ExecFileOptions, SpawnOptions } from 'node:child_process'

export type { ChildProcess, ExecFileOptions, SpawnOptions }

export interface ExecFileResult {
	stdout: string
	stderr: string
}

export interface ProcessRunner {
	/**
	 * Execute a file with arguments; buffers stdout/stderr and resolves with them.
	 * Rejects if the child exits with a non-zero code (Node semantics).
	 */
	execFile(file: string, args: string[], options?: ExecFileOptions): Promise<ExecFileResult>

	/**
	 * Spawn a child process; caller manages streams and lifecycle.
	 */
	spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess
}
