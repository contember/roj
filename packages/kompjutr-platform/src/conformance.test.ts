/**
 * The SDK's port contract, run against a kompjutr workspace.
 *
 * This is the gate the adapter is built to: every clause the port doc states,
 * asserted by the SDK itself rather than by tests written alongside the code
 * they check. A port this host does not answer is reported as a skip with its
 * reason, so what is missing stays visible instead of passing quietly.
 */

import type { Platform } from '@roj-ai/sdk/platform'
import { runPlatformConformance } from '@roj-ai/sdk/testing/conformance'
import { createGit, Workspace } from 'kompjutr'
import { createKompjutrPlatform } from './index.js'
import { BunSqliteStorage } from './testing/storage.js'

const ROOT = '/conformance'

/** The suite hands back a `PlatformInstance`, and a symlink needs the workspace behind it. */
const workspaces = new WeakMap<Platform, Workspace>()

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
		const workspace = workspaces.get(instance.platform)
		if (workspace === undefined) throw new Error('no workspace for this platform')
		workspace.filesystem.symlink(targetPath, linkPath)
		await Promise.resolve()
	},
})
