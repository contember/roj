/**
 * User Configuration type + defineConfig helper.
 *
 * The runtime loader (`loadUserConfig`) lives in the Bun runtime package
 * since it performs dynamic imports that require a runtime context.
 */

import type { Preset } from '~/core/preset/index.js'
import type { ExtraBind } from '~/plugins/shell/plugin.js'

/**
 * User configuration for the agent server.
 */
export interface RojConfig {
	/** Base directory for sessions (default: cwd) */
	sessionsDir?: string
	/** Whether sandbox (bwrap) is active (default: true) */
	sandboxed?: boolean
	/** Enable snapshotter for tracking file changes (e.g. 'jj' for Jujutsu VCS) */
	snapshotter?: 'jj'
	/** Extra paths to bind-mount inside bwrap sandbox */
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
