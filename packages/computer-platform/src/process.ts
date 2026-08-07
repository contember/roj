/**
 * ProcessRunner implementations for isolate hosts.
 *
 * A Worker isolate has no process table, so `spawn` — which returns a Node
 * `ChildProcess` with streams, `kill()` and `'exit'` — always rejects. The shim
 * over an exec handle it would need is deliberately out of scope.
 *
 * `execFile` buffers and resolves, which maps onto a workspace shell backend:
 * `createShellProcessRunner` routes it to `workspace.runtime.exec`, running the
 * command over the same SQLite filesystem the fs adapter writes to. Hosts with
 * no backend registered keep `createUnsupportedProcessRunner`, which fails at
 * the call site rather than at plugin registration.
 */

import { shellQuote } from '@cloudflare/computer'
import type { Workspace, WorkspaceRuntimeResult } from '@cloudflare/computer'
import type { ChildProcess, ExecFileOptions, ExecFileResult, ProcessRunner } from '@roj-ai/sdk/platform'

function unsupported(operation: string, command: string): Error {
	return Object.assign(
		new Error(`${operation}(${command}) is unavailable: no process table in a Worker isolate`),
		{ code: 'ENOSYS' },
	)
}

export function createUnsupportedProcessRunner(): ProcessRunner {
	return {
		execFile: (file): Promise<ExecFileResult> => Promise.reject(unsupported('execFile', file)),
		spawn: (command): ChildProcess => {
			throw unsupported('spawn', command)
		},
	}
}

export interface ShellProcessRunnerOptions {
	/** Workspace backend to run on. Defaults to the workspace's first backend. */
	backend?: string
}

/**
 * ProcessRunner whose `execFile` runs on a workspace shell backend.
 *
 * The backend takes a command line, not an argv array, so file and arguments
 * are quoted back into one — no caller-supplied string reaches the shell
 * unquoted. `maxBuffer`, `signal` and `encoding` are ignored: the backend
 * buffers the whole output and always decodes it as UTF-8.
 */
export function createShellProcessRunner(workspace: Workspace, options: ShellProcessRunnerOptions = {}): ProcessRunner {
	return {
		async execFile(file, args, execOptions): Promise<ExecFileResult> {
			const command = [file, ...args].map(shellQuote).join(' ')
			const handle = await workspace.runtime.exec(command, {
				backend: options.backend,
				encoding: 'utf8',
				cwd: toCwd(execOptions?.cwd),
				env: toEnv(execOptions?.env),
				// Node reads timeout 0 as "no timeout"; the backend reads it as "expire now".
				timeoutMs: execOptions?.timeout ? execOptions.timeout : undefined,
			})

			let result: WorkspaceRuntimeResult<'utf8'>
			try {
				result = await handle.result()
			} finally {
				handle[Symbol.dispose]()
			}

			if (result.status !== 'completed' || result.exitCode !== 0) throw failed(command, result)
			return { stdout: result.stdout, stderr: result.stderr }
		},

		spawn: (command): ChildProcess => {
			throw unsupported('spawn', command)
		},
	}
}

function toCwd(cwd: ExecFileOptions['cwd']): string | undefined {
	if (cwd === undefined) return undefined
	return typeof cwd === 'string' ? cwd : cwd.pathname
}

/** ProcessEnv is `string | undefined`-valued; the backend takes only strings. */
function toEnv(env: ExecFileOptions['env']): Record<string, string> | undefined {
	if (env === undefined) return undefined
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) out[key] = value
	}
	return out
}

/** Shaped like a node execFile rejection — callers read `code`, `stdout` and `stderr` off it. */
function failed(command: string, result: WorkspaceRuntimeResult<'utf8'>): Error {
	return Object.assign(new Error(`Command failed: ${command}\n${result.stderr}`), {
		code: result.exitCode,
		killed: result.status === 'cancelled',
		stdout: result.stdout,
		stderr: result.stderr,
	})
}
