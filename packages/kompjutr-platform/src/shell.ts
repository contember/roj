import type { ShellConfinement, ShellGrant, ShellRunner } from '@roj-ai/sdk/platform'
import type { Filesystem, Git } from '@kompjutr/do'
import { createMountedFilesystem } from '@kompjutr/do/fs'
import { createGitCommand } from '@kompjutr/do/git-shell'
import { createShell } from '@kompjutr/do/shell'
import { createConfinedGitRunner } from './confined-git.js'
import { GrantMounts } from './mounts.js'

export interface KompjutrShellRunnerOptions {
	filesystem: Filesystem
	/** Adds the `git` command when the workspace was configured with Git. */
	git?: Git
	/**
	 * `paths` shows each run only its grants; `host` is valid only when this
	 * workspace contains one session's files. Defaults to `none`.
	 */
	confinement?: ShellConfinement
}

type ShellCommands = NonNullable<Parameters<typeof createShell>[0]['commands']>

interface ShellScope {
	filesystem: Filesystem
	commands?: ShellCommands
}

function quoteShellWord(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`
}

export function createKompjutrShellRunner(options: KompjutrShellRunnerOptions): ShellRunner {
	const confinement = options.confinement ?? 'none'
	const unconfined: ShellScope = {
		filesystem: options.filesystem,
		commands: options.git === undefined ? undefined : new Map([['git', createGitCommand(options.git)]]),
	}

	return {
		confinement,
		supportsTimeout: false,
		async run(runOptions) {
			if (!runOptions.cwd.startsWith('/')) throw new Error('kompjutr shell requires an absolute cwd')
			if (confinement !== 'paths' && (runOptions.grants?.length ?? 0) > 0) {
				throw new Error('kompjutr shell does not support path grants without paths confinement')
			}

			// Without grants the caller asks for no confinement, as with the Bun sandbox.
			const scope = confinement === 'paths' && runOptions.grants !== undefined ? confinedScope(options, runOptions.grants) : unconfined
			// ShellSession caches cwd per instance, even though instances share the default SQL row.
			const shell = createShell({ fs: scope.filesystem, commands: scope.commands })
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

/** A fail-closed view of the run's grants, with Git translated between that view and real space. */
function confinedScope(options: KompjutrShellRunnerOptions, grants: readonly ShellGrant[]): ShellScope {
	const mounts = new GrantMounts(options.filesystem, grants)
	const view = createMountedFilesystem(options.filesystem, mounts.specs)
	if (options.git === undefined) return { filesystem: view }
	return {
		filesystem: view,
		commands: new Map([['git', createGitCommand(createConfinedGitRunner(options.git, view, mounts))]]),
	}
}
