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
}

/**
 * Type sugar for defining configuration (like Vite, Vitest, etc.).
 * Provides better DX with type inference.
 */
export function defineConfig(config: RojConfig): RojConfig {
	return config
}
