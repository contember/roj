/**
 * User Configuration type + defineConfig helper.
 *
 * The runtime loader (`loadUserConfig`) lives in the Bun runtime package
 * since it performs dynamic imports that require a runtime context.
 */

import type { SessionPluginConfig } from '~/core/plugins/plugin-builder.js'
import type { Preset } from '~/core/preset/index.js'
import type { ExtraBind } from '~/plugins/shell/plugin.js'

/**
 * User configuration for the agent server.
 */
export interface RojConfig {
	/** Base directory for sessions (default: cwd) */
	sessionsDir?: string
	/** Sandbox (bwrap) posture for presets that do not set their own `sandboxed` (default: false) */
	sandboxed?: boolean
	/** Enable snapshotter for tracking file changes (e.g. 'jj' for Jujutsu VCS) */
	snapshotter?: 'jj'
	/** Extra paths to bind-mount inside the bwrap sandbox, for presets whose shell plugin declares none */
	extraBinds?: ExtraBind[]
	/** Presets available in this configuration */
	presets: Preset[]
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
 * Fold the top-level sandbox settings into every preset, so a `RojConfig` that
 * declares them actually takes effect. A preset that sets its own value keeps it.
 */
export function applySandboxSettings(config: RojConfig): Preset[] {
	return config.presets.map(preset => ({
		...preset,
		sandboxed: preset.sandboxed ?? config.sandboxed ?? false,
		plugins: config.extraBinds?.length ? withExtraBinds(preset.plugins, config.extraBinds) : preset.plugins,
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
