/**
 * The SDK's port contract, run against a kompjutr workspace.
 *
 * This is the gate the adapter is built to: every clause the port doc states,
 * asserted by the SDK itself rather than by tests written alongside the code
 * they check. A port this host does not answer is reported as a skip with its
 * reason, so what is missing stays visible instead of passing quietly.
 */

import type { Platform } from '@roj-ai/sdk/platform'
import { GIT_FIXTURE, runPlatformConformance } from '@roj-ai/sdk/testing/conformance'
import { createGit, Workspace } from 'kompjutr'
import { createKompjutrPlatform } from './index.js'
import { BunSqliteStorage } from './testing/storage.js'

const ROOT = '/conformance'

/** The suite hands back a `PlatformInstance`; symlinks and the git fixture need the workspace behind it. */
const workspaces = new WeakMap<Platform, Workspace>()

function workspaceOf(platform: Platform): Workspace {
	const workspace = workspaces.get(platform)
	if (workspace === undefined) throw new Error('no workspace for this platform')
	return workspace
}

runPlatformConformance({
	name: 'kompjutr',

	create() {
		const workspace = new Workspace({
			storage: new BunSqliteStorage(),
			git: createGit(),
			defaultGitIdentity: { name: 'Roj', email: 'roj@example.com' },
		})
		workspace.filesystem.mkdir(ROOT, { recursive: true })

		const platform = createKompjutrPlatform(workspace)
		workspaces.set(platform, workspace)

		return { platform, root: ROOT }
	},

	// The default shells out to `ln -s`, and this host has nothing to shell out to.
	async symlink(instance, targetPath, linkPath) {
		workspaceOf(instance.platform).filesystem.symlink(targetPath, linkPath)
		await Promise.resolve()
	},

	// Likewise: the default runs the `git` binary. This builds GIT_FIXTURE natively.
	async buildGitRepo(instance, dir) {
		const workspace = workspaceOf(instance.platform)
		const { filesystem, git } = workspace
		const write = (path: string, content: string): void => filesystem.writeFile(path, new TextEncoder().encode(content))

		filesystem.mkdir(dir, { recursive: true })
		await git.init({ dir, defaultBranch: GIT_FIXTURE.base })

		write(`${dir}/${GIT_FIXTURE.modified}`, 'first\n')
		await git.add({ dir, paths: [GIT_FIXTURE.modified] })
		await git.commit({ dir, message: GIT_FIXTURE.baseSubject })

		// Moves HEAD without touching the worktree, so `feature` forks at `first`.
		await git.branch({ dir, name: GIT_FIXTURE.branch, checkout: true })
		write(`${dir}/${GIT_FIXTURE.modified}`, 'second\n')
		await git.add({ dir, paths: [GIT_FIXTURE.modified] })
		await git.commit({ dir, message: GIT_FIXTURE.headSubject })

		write(`${dir}/${GIT_FIXTURE.modified}`, 'second, and then edited\n')
		write(`${dir}/${GIT_FIXTURE.untracked}`, 'untracked\n')
	},
})
