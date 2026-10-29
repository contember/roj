#!/usr/bin/env bun
/**
 * Main Entry Point for Agent Server
 *
 * Usage:
 *   bun src/main.ts [config-path]
 *   bunx @roj-ai/sandbox-runtime [bundle-path]   (sandbox runtime case)
 *
 * Arguments:
 *   path  Path to roj.config.ts (dev) or a built bundle.js (sandbox).
 *         Defaults to roj.config.ts in CWD.
 *
 * When run inside an E2B sandbox, the agent bundle was built with
 * `runtime.external = true`, so its `import "@roj-ai/*"` calls need to
 * resolve to the runtime's installed copy. This entry point ensures
 * `<bundleDir>/node_modules/@roj-ai` points at the runtime's `@roj-ai`
 * dir before dynamic-importing the bundle. When it has to create the
 * link, it runs itself once more so Bun sees the link (see sdk-link.ts).
 * Idempotent: workspace dev setups already have `@roj-ai/*` resolvable
 * upward, so the symlink step is skipped.
 */

import { resolve, dirname } from 'node:path'
import { linkSdkOrRelaunch } from './sdk-link.js'
import { startServer } from './server.js'
import { loadUserConfig } from './user-config-loader.js'

async function main() {
	const configPath = process.argv[2] ?? 'roj.config.ts'
	const absoluteConfigPath = resolve(process.cwd(), configPath)
	const bundleDir = dirname(absoluteConfigPath)

	const relaunchedExitCode = await linkSdkOrRelaunch(bundleDir)
	if (relaunchedExitCode !== null) process.exit(relaunchedExitCode)

	let userConfig: Awaited<ReturnType<typeof loadUserConfig>>
	try {
		userConfig = await loadUserConfig(absoluteConfigPath)
		console.log(`Loaded config from: ${absoluteConfigPath}`)
		console.log(`  Presets: ${userConfig.presets.map((p) => p.id).join(', ')}`)
	} catch (error) {
		console.error(`Failed to load user config from ${absoluteConfigPath}:`)
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}

	await startServer(userConfig)
}

main().catch((error) => {
	console.error('Fatal error:', error)
	process.exit(1)
})
