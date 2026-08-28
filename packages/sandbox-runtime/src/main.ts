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
 * dir before dynamic-importing the bundle. Idempotent: workspace dev
 * setups already have `@roj-ai/*` resolvable upward, so the symlink
 * step is skipped.
 */

import { resolve, dirname, join } from 'node:path'
import { symlink, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { applySandboxSettings, describeSandboxPosture } from '@roj-ai/sdk/user-config'
import { startServer } from './server.js'
import { loadUserConfig } from './user-config-loader.js'

async function ensureSdkResolvable(bundleDir: string): Promise<void> {
	const userReq = createRequire(join(bundleDir, '__roj_anchor__'))
	try {
		userReq.resolve('@roj-ai/sdk/package.json')
		return
	} catch {
		// Not resolvable — fall through to symlink path.
	}

	const runtimeReq = createRequire(import.meta.url)
	const sdkPkgPath = runtimeReq.resolve('@roj-ai/sdk/package.json')
	const runtimeRojDir = resolve(sdkPkgPath, '..', '..')

	const linkPath = join(bundleDir, 'node_modules', '@roj-ai')
	await rm(linkPath, { recursive: true, force: true })
	await mkdir(dirname(linkPath), { recursive: true })
	await symlink(runtimeRojDir, linkPath, 'dir')
	console.log(`[sandbox-runtime] linked ${linkPath} → ${runtimeRojDir}`)
}

async function main() {
	const configPath = process.argv[2] ?? 'roj.config.ts'
	const absoluteConfigPath = resolve(process.cwd(), configPath)
	const bundleDir = dirname(absoluteConfigPath)

	await ensureSdkResolvable(bundleDir)

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

	const presets = applySandboxSettings(userConfig)
	console.log(`  Sandbox: ${describeSandboxPosture(presets)}`)

	await startServer({ presets })
}

main().catch((error) => {
	console.error('Fatal error:', error)
	process.exit(1)
})
