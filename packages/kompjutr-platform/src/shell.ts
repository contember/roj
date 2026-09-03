import type { ShellRunner } from '@roj-ai/sdk/platform'
import type { Filesystem, Git } from 'kompjutr'
import { createGitCommand } from 'kompjutr/git/shell'
import { createShell } from 'kompjutr/shell'

export interface KompjutrShellRunnerOptions {
	filesystem: Filesystem
	/** Adds the `git` command when the workspace was configured with Git. */
	git?: Git
	/** `host` is valid only when this workspace contains one session's files. */
	confinement?: 'host' | 'none'
}

function quoteShellWord(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`
}

export function createKompjutrShellRunner(options: KompjutrShellRunnerOptions): ShellRunner {
	const commands = options.git === undefined
		? undefined
		: new Map([['git', createGitCommand(options.git)]])
	const shell = createShell({ fs: options.filesystem, commands })

	return {
		confinement: options.confinement ?? 'none',
		supportsTimeout: false,
		async run(runOptions) {
			if (!runOptions.cwd.startsWith('/')) throw new Error('kompjutr shell requires an absolute cwd')
			if ((runOptions.grants?.length ?? 0) > 0) {
				throw new Error('kompjutr shell does not support path grants')
			}

			const result = await shell.run(`cd ${quoteShellWord(runOptions.cwd)} && ${runOptions.command}`, {
				env: runOptions.env,
				stdin: runOptions.stdin,
			})
			return {
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				timedOut: false,
				truncated: result.truncated,
			}
		},
	}
}
