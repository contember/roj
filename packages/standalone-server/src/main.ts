#!/usr/bin/env bun
/**
 * CLI entry: run the standalone roj server from a `roj.config.ts` file.
 *
 * Usage:
 *   bun standalone-server [config-path]     (default: roj.config.ts)
 *   bunx roj-standalone [config-path]
 */

import { resolve } from 'node:path'
import { startStandaloneServer } from './server.js'
import { loadUserConfig } from './user-config-loader.js'

async function main() {
	const configPath = process.argv[2] ?? 'roj.config.ts'
	const absoluteConfigPath = resolve(process.cwd(), configPath)

	let userConfig: Awaited<ReturnType<typeof loadUserConfig>>
	try {
		userConfig = await loadUserConfig(absoluteConfigPath)
		console.log(`Loaded config from: ${absoluteConfigPath}`)
		console.log(`  Presets: ${userConfig.presets.map(p => p.id).join(', ')}`)
	} catch (error) {
		console.error(`Failed to load config from ${absoluteConfigPath}:`)
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}

	await startStandaloneServer({ presets: userConfig.presets })
}

main().catch((error) => {
	console.error('Fatal error:', error)
	process.exit(1)
})
