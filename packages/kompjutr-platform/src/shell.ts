import type { ShellRunner } from '@roj-ai/sdk/platform'
import type { Filesystem, Git } from '@kompjutr/do'
import { createGitCommand } from '@kompjutr/do/git-shell'
import { createShell } from '@kompjutr/do/shell'

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
	const commands = options.git === undefined ? undefined : new Map([['git', createGitCommand(options.git)]])

	return {
		confinement: options.confinement ?? 'none',
		supportsTimeout: false,
		async run(runOptions) {
			if (!runOptions.cwd.startsWith('/')) throw new Error('kompjutr shell requires an absolute cwd')
			if ((runOptions.grants?.length ?? 0) > 0) {
				throw new Error('kompjutr shell does not support path grants')
			}

			// ShellSession caches cwd per instance, even though instances share the default SQL row.
			const shell = createShell({ fs: options.filesystem, commands })
			const cwdResult = await shell.run(`cd ${quoteShellWord(runOptions.cwd)}`)
			const result =
				cwdResult.exitCode === 0
					? await shell.run(runOptions.command, {
							env: runOptions.env,
							stdin: runOptions.stdin,
						})
					: cwdResult
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
