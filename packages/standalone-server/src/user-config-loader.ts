/**
 * Runtime loader for the user `roj.config.ts` file.
 *
 * Uses dynamic `import()` — kept out of `@roj-ai/sdk` (which stays free of
 * runtime-specific I/O) and out of `@roj-ai/sandbox-runtime` (Bun-specific).
 */

import type { LocalResource, Preset, RojConfig } from '@roj-ai/sdk'
import { parseExtraBinds, validatePreset } from '@roj-ai/sdk'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

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

	const configDir = dirname(absolutePath)
	const localResources = parseLocalResources(typedConfig.localResources, configDir, absolutePath)

	return {
		presets,
		sandboxed: typedConfig.sandboxed as boolean | undefined,
		snapshotter: typedConfig.snapshotter as RojConfig['snapshotter'],
		extraBinds: parseExtraBinds(typedConfig.extraBinds, configDir, absolutePath),
		localResources,
	}
}

function parseLocalResources(raw: unknown, configDir: string, configPath: string): LocalResource[] | undefined {
	if (raw === undefined) return undefined
	if (!Array.isArray(raw)) {
		throw new Error(`'localResources' must be an array: ${configPath}`)
	}

	const seen = new Set<string>()
	return raw.map((entry, i) => {
		if (typeof entry !== 'object' || entry === null) {
			throw new Error(`localResources[${i}] must be an object: ${configPath}`)
		}
		const r = entry as Record<string, unknown>
		if (typeof r.slug !== 'string' || !r.slug) {
			throw new Error(`localResources[${i}] missing required 'slug': ${configPath}`)
		}
		if (typeof r.path !== 'string' || !r.path) {
			throw new Error(`localResources[${i}] missing required 'path': ${configPath}`)
		}
		if (seen.has(r.slug)) {
			throw new Error(`Duplicate localResources slug '${r.slug}': ${configPath}`)
		}
		seen.add(r.slug)

		const resolvedPath = isAbsolute(r.path) ? r.path : resolve(configDir, r.path)
		if (!existsSync(resolvedPath)) {
			throw new Error(`localResources[${i}] file not found: ${resolvedPath} (config: ${configPath})`)
		}
		return {
			slug: r.slug,
			path: resolvedPath,
			name: typeof r.name === 'string' ? r.name : undefined,
		}
	})
}
