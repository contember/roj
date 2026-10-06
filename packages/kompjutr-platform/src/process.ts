/**
 * `ProcessRunner` for a host with no process table.
 *
 * The port is required, because every host the SDK knew until now had one. A
 * kompjutr workspace does not: it is a filesystem and a git runtime, and the
 * command lines an agent writes are answered by `platform.shell` instead.
 *
 * So both methods fail, and they fail loudly rather than pretending. A caller
 * that needs a real process is a caller this host cannot serve, and the plugin
 * profile is what keeps those callers out — not a stub that returns nothing.
 */

import type { ChildProcess, ExecFileResult, ProcessRunner } from '@roj-ai/sdk/platform'

function unsupported(what: string): Error {
	return Object.assign(new Error(`${what} is not available: this host has no process table`), { code: 'ENOSYS' })
}

export function createUnsupportedProcessRunner(): ProcessRunner {
	return {
		execFile(file: string): Promise<ExecFileResult> {
			return Promise.reject(unsupported(`execFile(${file})`))
		},
		spawn(command: string): ChildProcess {
			throw unsupported(`spawn(${command})`)
		},
	}
}
