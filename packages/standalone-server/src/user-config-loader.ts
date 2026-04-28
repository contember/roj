/**
 * Runtime loader for the user `roj.config.ts` file.
 *
 * Uses dynamic `import()` — kept out of `@roj-ai/sdk` (which stays free of
 * runtime-specific I/O) and out of `@roj-ai/sandbox-runtime` (Bun-specific).
 */

import type { Preset, RojConfig } from '@roj-ai/sdk'
import { validatePreset } from '@roj-ai/sdk'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export async function loadUserConfig(configPath: string): Promise<RojConfig> {
	const absolutePath = resolve(process.cwd(), configPath)

	if (!existsSync(absolutePath)) {
		throw new Error(`Configuration file not found: ${absolutePath}`)
	}

	let mod: unknown
	try {
		mod = await import(absolutePath)
	} catch (error) {
		throw new Error(
			`Failed to load configuration file: ${absolutePath}\n${error instanceof Error ? error.message : String(error)}`,
		)
	}

	const config = (mod as { default?: unknown }).default
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
		throw new Error(`Preset validation errors:\n${allErrors.map(e => `  - ${e}`).join('\n')}`)
	}

	const ids = presets.map(p => p.id)
	const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
	if (duplicates.length > 0) {
		throw new Error(`Duplicate preset IDs: ${[...new Set(duplicates)].join(', ')}`)
	}

	return {
		presets,
		sandboxed: typedConfig.sandboxed as boolean | undefined,
		snapshotter: typedConfig.snapshotter as RojConfig['snapshotter'],
	}
}
