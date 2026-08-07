/**
 * ProcessRunner for isolate backends.
 *
 * A Worker isolate has no process table. Every call rejects with ENOSYS so
 * plugins that shell out (services, resources, git-status, upload
 * preprocessors) fail loudly at the call site rather than at registration.
 * Routing these to `workspace.runtime.exec` needs a ChildProcess-shaped shim
 * over the exec handle — deliberately out of scope here.
 */

import type { ChildProcess, ExecFileResult, ProcessRunner } from '@roj-ai/sdk/platform'

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
