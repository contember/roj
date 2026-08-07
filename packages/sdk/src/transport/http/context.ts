/**
 * Hono context types and the services accessor.
 *
 * Kept out of app.ts on purpose. The route factories need `getServices` — a
 * runtime value, not just a type — while app.ts imports every route factory to
 * mount them. With both in app.ts the ESM module graph really does contain a
 * cycle (app -> routes/* -> app), not merely a type-shape artifact. This module
 * imports nothing from app.ts, so the graph stays acyclic.
 */

import type { PreprocessorRegistry } from '~/plugins/uploads/preprocessor.js'
import type { PluginProfile, Services } from '../../bootstrap.js'
import type { SessionManager } from '../../core/sessions/session-manager.js'

/**
 * Extended services with SessionManager for HTTP routes.
 *
 * Generic over the bootstrap plugin profile, defaulting to `full` like
 * {@link Services} — so a bare `AppServices` still means the full profile, and
 * an isolate host can mount the same app over `Services<'isolate'>`.
 */
export type AppServices<TProfile extends PluginProfile = 'full'> = Services<TProfile> & {
	sessionRuntime: SessionManager
	/** Bearer token for authenticating HTTP requests. Optional - only used in worker mode. */
	agentToken?: string
	/** File preprocessor registry for upload routes. Optional - only available when uploads plugin is configured. */
	preprocessorRegistry?: PreprocessorRegistry
}

/**
 * Environment type for Hono app with injected services.
 *
 * Profile-agnostic: no route reads `pluginProfile`, and pinning it here would
 * force every route factory to become generic for nothing.
 */
export type AppEnv = {
	Variables: {
		services: AppServices<PluginProfile>
	}
}

/**
 * Hono context type for routes.
 */
export type AppContext = import('hono').Context<AppEnv>

/**
 * Type-safe accessor for services from Hono context.
 * Guarantees services are present (set by middleware).
 */
export function getServices(c: AppContext): AppServices<PluginProfile> {
	return c.get('services')
}
