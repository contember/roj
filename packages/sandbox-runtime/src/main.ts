/**
 * Main Entry Point for Agent Server
 *
 * Usage:
 *   bun src/main.ts [config-path]
 *
 * Arguments:
 *   config-path  Path to roj.config.ts (default: roj.config.ts in CWD)
 */

import { resolve } from 'node:path'
import { startServer } from './server.js'
import { loadUserConfig } from './user-config-loader.js'

async function main() {
	const configPath = process.argv[2] ?? 'roj.config.ts'
	const absoluteConfigPath = resolve(process.cwd(), configPath)

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

	await startServer({ presets: userConfig.presets })
}

main().catch((error) => {
	console.error('Fatal error:', error)
	process.exit(1)
})
