/**
 * User Configuration type + defineConfig helper.
 *
 * The runtime loader (`loadUserConfig`) lives in the Bun runtime package
 * since it performs dynamic imports that require a runtime context.
 */

import { isAbsolute, resolve } from 'node:path'
import type { SessionPluginConfig } from '~/core/plugins/plugin-builder.js'
import type { Preset } from '~/core/preset/index.js'
import type { ExtraBind } from '~/plugins/shell/plugin.js'

/**
 * The config a host must hand to `bootstrap` for sessions to be built the way
 * the user declared them. Server option types extend it, so a new entry point
 * cannot quietly forward the presets alone.
 */
export interface SessionDefaults {
	/** Presets available in this configuration */
	presets: Preset[]
	/** Sandbox (bwrap) posture for presets that do not set their own `sandboxed` (default: false) */
	sandboxed?: boolean
	/**
	 * Extra paths to bind-mount inside the bwrap sandbox, for presets whose shell
	 * plugin declares none. `path` is on the host, `destPath` inside the sandbox.
	 */
	extraBinds?: ExtraBind[]
}

/**
 * User configuration for the agent server.
 */
export interface RojConfig extends SessionDefaults {
	/** Base directory for sessions (default: cwd) */
	sessionsDir?: string
	/** Enable snapshotter for tracking file changes (e.g. 'jj' for Jujutsu VCS) */
	snapshotter?: 'jj'
	/**
	 * Local resource registry — files (typically ZIPs) on disk addressable by slug,
	 * standing in for the platform's resource service. The standalone server reads
	 * these at startup and injects them into new sessions whose preset declares a
	 * matching `defaultResourceSlugs` entry, mirroring roj-platform's
	 * `inject-resources` step.
	 *
	 * `path` is resolved relative to the config file directory.
	 */
	localResources?: LocalResource[]
	/**
	 * Bundle runtime delivery mode. When `external: true`, `roj build` emits a
	 * bundle that imports `@roj-ai/*` from the sandbox's installed SDK at run
	 * time instead of inlining it. The platform resolves the actual SDK version
	 * from `rojVersion` (build-time) and the lock policy below; only `lockMinor`
	 * is user-controllable — major is always locked, patch always floats.
	 */
	runtime?: RuntimeConfig
}

export interface RuntimeConfig {
	/** Opt into externalized SDK loading. Default: false (self-contained bundle). */
	external?: boolean
	/** When true, only patch versions float; minor is pinned to build-time. Default: true. Ignored when external !== true. */
	lockMinor?: boolean
}

export interface LocalResource {
	/** Resource slug — matched against preset.defaultResourceSlugs */
	slug: string
	/** Filesystem path to the resource file (typically a .zip), relative to the config file */
	path: string
	/** Optional human-readable name surfaced in inject-resource metadata */
	name?: string
}

/**
 * Type sugar for defining configuration (like Vite, Vitest, etc.).
 * Provides better DX with type inference.
 */
export function defineConfig(config: RojConfig): RojConfig {
	return config
}

const SHELL_PLUGIN_NAME = 'shell'

/**
 * Fold the top-level sandbox settings into every preset, so a config that
 * declares them takes effect. A preset that sets its own value keeps it.
 *
 * `bootstrap` calls this, and every host goes through `bootstrap` — an entry
 * point should forward its `SessionDefaults` rather than fold them itself.
 */
export function applySandboxSettings(settings: SessionDefaults): Preset[] {
	return settings.presets.map(preset => ({
		...preset,
		sandboxed: preset.sandboxed ?? settings.sandboxed ?? false,
		plugins: settings.extraBinds !== undefined ? withExtraBinds(preset.plugins, settings.extraBinds) : preset.plugins,
	}))
}

/** One-line summary of the resolved sandbox posture, for startup logging. */
export function describeSandboxPosture(presets: Preset[]): string {
	const on = presets.filter(p => p.sandboxed).map(p => p.id)
	const off = presets.filter(p => !p.sandboxed).map(p => p.id)
	if (on.length === 0) return 'off'
	if (off.length === 0) return 'on'
	return `on for ${on.join(', ')}; off for ${off.join(', ')}`
}

/**
 * Validate the `extraBinds` of a config file. A relative host `path` resolves
 * against the config directory, the way `localResources` does. `destPath` names
 * a location inside the sandbox, so it has nothing to resolve against and must
 * already be absolute.
 */
export function parseExtraBinds(raw: unknown, configDir: string, configPath: string): ExtraBind[] | undefined {
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
		if (destPath !== undefined && (typeof destPath !== 'string' || !isAbsolute(destPath))) {
			throw new Error(`extraBinds[${i}] 'destPath' must be an absolute path inside the sandbox: ${configPath}`)
		}
		return { path: isAbsolute(path) ? path : resolve(configDir, path), mode, destPath }
	})
}

// The shell plugin is the only consumer of extraBinds — a preset without it has nothing to bind into.
function withExtraBinds(
	plugins: SessionPluginConfig[] | undefined,
	extraBinds: ExtraBind[],
): SessionPluginConfig[] | undefined {
	return plugins?.map(entry => {
		if (entry.pluginName !== SHELL_PLUGIN_NAME) return entry
		const current = entry.config
		if (typeof current !== 'object' || current === null) return entry
		if ('extraBinds' in current && current.extraBinds !== undefined) return entry
		return { ...entry, config: { ...current, extraBinds } }
	})
}
