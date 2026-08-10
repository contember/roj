/**
 * Hono App Setup
 *
 * Creates the main HTTP application with middleware and routes.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { SDK_VERSION } from '~/info.js'
import type { PluginProfile } from '../../bootstrap.js'
import type { AppEnv, AppServices } from './context.js'
import { getServices } from './context.js'
import { createBearerAuth } from './middleware/bearer-auth.js'
import { errorHandler } from './middleware/error-handler.js'
import { createFileRoutes } from './routes/files.js'
import { createResourceRoutes } from './routes/resources.js'
import { createRpcRoutes } from './routes/rpc.js'
import { createUploadRoutes } from './routes/upload.js'

// Re-exported so `from './app.js'` keeps working for consumers; the
// declarations live in context.js, which routes import directly.
export type { AppContext, AppEnv, AppServices } from './context.js'
export { getServices } from './context.js'

/**
 * Creates the Hono application with all middleware and routes.
 *
 * Accepts either profile — `AppServices<'full'>` and `AppServices<'isolate'>`
 * both widen to `AppServices<PluginProfile>`.
 */
export function createApp(services: AppServices<PluginProfile>): Hono<AppEnv> {
	const app = new Hono<AppEnv>()

	// Middleware
	app.use('*', cors())
	app.use('*', async (c, next) => {
		c.set('services', services)
		await next()
	})

	// Error handler
	app.onError(errorHandler)

	// Health check (public - no auth required)
	app.get('/health', (c) => {
		return c.json({
			status: 'ok',
			timestamp: Date.now(),
		})
	})

	// Bearer auth for protected routes
	const bearerAuth = createBearerAuth(services.agentToken)

	/**
	 * Activity status for DO polling (protected).
	 *
	 * Two kinds of number, deliberately named apart:
	 *
	 * - **Live** — `lastActivityAt`, `stats.sessionCount`, `pendingAgents`,
	 *   `processingAgents` and `sessions[]` describe what this instance holds in
	 *   memory *now*. On a host that can be evicted (a Durable Object) that is
	 *   whatever survived the last eviction, so they move with isolate lifetime,
	 *   and `lastActivityAt` is null whenever nothing is loaded. A liveness
	 *   signal, not a history.
	 * - **Durable** — `stats.storedSessionCount` is every session the event store
	 *   holds, of any status, and does not move when the isolate is recycled.
	 *
	 * So `storedSessionCount > 0 && sessionCount === 0` reads as "sessions exist,
	 * none are loaded" rather than as "there are no sessions". Per-session detail
	 * beyond the live set — status, metrics, paging — is what the `sessions.list`
	 * RPC is for; it costs one metadata read per session, which this endpoint is
	 * polled too often to pay.
	 */
	app.get('/status', bearerAuth, async (c) => {
		const { sessionRuntime, config } = getServices(c)
		const [stats, storedSessionCount] = await Promise.all([
			sessionRuntime.getStats(),
			sessionRuntime.countStoredSessions(),
		])

		return c.json({
			lastActivityAt: stats.lastActivityAt,
			versions: {
				sdk: SDK_VERSION,
				runtime: config.agentRuntime ?? null,
			},
			stats: {
				sessionCount: stats.sessionCount,
				loadedSessionCount: stats.loadedSessionCount,
				pendingAgents: stats.pendingAgents,
				processingAgents: stats.processingAgents,
				storedSessionCount,
			},
			sessions: stats.sessions.map(s => ({
				id: s.id,
				presetId: s.presetId,
				status: s.status,
				metrics: s.metrics,
			})),
			timestamp: Date.now(),
		})
	})

	// Protected routes
	app.use('/rpc/*', bearerAuth)
	app.use('/sessions/*', bearerAuth)
	app.route('/rpc', createRpcRoutes())

	// Uploads and resources are thin shells over their plugins, and the isolate
	// profile registers neither — mounted there they answer 400 "Unknown plugin"
	// at request time where the route simply does not exist. File routes read
	// through platform.fs, so they mount under every profile.
	if (services.pluginProfile === 'full') {
		app.route('/sessions', createUploadRoutes())
		app.route('/sessions', createResourceRoutes())
	}
	app.route('/sessions', createFileRoutes())

	// 404 handler
	app.notFound((c) => {
		return c.json(
			{
				error: {
					type: 'not_found',
					message: `Route not found: ${c.req.method} ${c.req.path}`,
				},
			},
			404,
		)
	})

	return app
}
