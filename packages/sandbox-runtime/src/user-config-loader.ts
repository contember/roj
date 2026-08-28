/**
 * Runtime loader for the user `roj.config.ts` file.
 *
 * Uses dynamic `import()` — this is why it lives in the runtime package
 * rather than in `@roj-ai/sdk` (which stays pure and platform-agnostic).
 */

import type { Preset, RojConfig } from '@roj-ai/sdk'
import { validatePreset } from '@roj-ai/sdk'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Load user configuration from a TypeScript file.
 *
 * @param configPath - Absolute or relative path to the config file
 * @returns Validated RojConfig
 * @throws Error if config file not found, invalid format, or preset validation fails
 */
export async function loadUserConfig(configPath: string): Promise<RojConfig> {
	const absolutePath = resolve(process.cwd(), configPath)

	if (!existsSync(absolutePath)) {
		throw new Error(`Configuration file not found: ${absolutePath}`)
	}

	let module: unknown
	try {
		module = await import(absolutePath)
	} catch (error) {
		throw new Error(
			`Failed to load configuration file: ${absolutePath}\n${error instanceof Error ? error.message : String(error)}`,
		)
	}

	const config = (module as { default?: unknown }).default

	if (!config) {
		throw new Error(`Configuration file must have a default export: ${absolutePath}`)
	}

	if (typeof config !== 'object' || config === null) {
		throw new Error(`Configuration must be an object: ${absolutePath}`)
	}

	const typedConfig = config as Record<string, unknown>

	if (!Array.isArray(typedConfig.presets)) {
		throw new Error(`Configuration must have a 'presets' array: ${absolutePath}`)
	}

	const presets = typedConfig.presets as Preset[]
	const allErrors: string[] = []

	for (const preset of presets) {
		if (!preset.id || typeof preset.id !== 'string') {
			allErrors.push(`Preset missing required 'id' field`)
			continue
		}

		const errors = validatePreset(preset)
		if (errors.length > 0) {
			allErrors.push(`Preset '${preset.id}': ${errors.join(', ')}`)
		}
	}

	if (allErrors.length > 0) {
		throw new Error(`Preset validation errors:\n${allErrors.map((e) => `  - ${e}`).join('\n')}`)
	}

	const ids = presets.map((p) => p.id)
	const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
	if (duplicates.length > 0) {
		throw new Error(`Duplicate preset IDs: ${[...new Set(duplicates)].join(', ')}`)
	}

	return {
		presets,
		sandboxed: typedConfig.sandboxed as boolean | undefined,
		snapshotter: typedConfig.snapshotter as RojConfig['snapshotter'],
		extraBinds: parseExtraBinds(typedConfig.extraBinds, absolutePath),
	}
}

type ExtraBind = NonNullable<RojConfig['extraBinds']>[number]

function parseExtraBinds(raw: unknown, configPath: string): ExtraBind[] | undefined {
	if (raw === undefined) return undefined
	if (!Array.isArray(raw)) {
		throw new Error(`'extraBinds' must be an array: ${configPath}`)
	}

	const entries: unknown[] = raw
	return entries.map((entry, i) => {
		if (typeof entry !== 'object' || entry === null) {
			throw new Error(`extraBinds[${i}] must be an object: ${configPath}`)
		}
		const path = 'path' in entry ? entry.path : undefined
		const mode = 'mode' in entry ? entry.mode : undefined
		const destPath = 'destPath' in entry ? entry.destPath : undefined
		if (typeof path !== 'string' || !path) {
			throw new Error(`extraBinds[${i}] missing required 'path': ${configPath}`)
		}
		if (mode !== 'rw' && mode !== 'ro') {
			throw new Error(`extraBinds[${i}] 'mode' must be 'rw' or 'ro': ${configPath}`)
		}
		if (destPath !== undefined && (typeof destPath !== 'string' || !destPath)) {
			throw new Error(`extraBinds[${i}] 'destPath' must be a non-empty string: ${configPath}`)
		}
		return { path, mode, destPath }
	})
}
