/**
 * Hono App Setup
 *
 * Creates the main HTTP application with middleware and routes.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { PreprocessorRegistry } from '~/plugins/uploads/preprocessor.js'
import type { Services } from '../../bootstrap.js'
import type { SessionManager } from '../../core/sessions/session-manager.js'
import { createBearerAuth } from './middleware/bearer-auth.js'
import { errorHandler } from './middleware/error-handler.js'
import { createFileRoutes } from './routes/files.js'
import { createResourceRoutes } from './routes/resources.js'
import { createRpcRoutes } from './routes/rpc.js'
import { createUploadRoutes } from './routes/upload.js'

/**
 * Extended services with SessionManager for HTTP routes.
 */
export type AppServices = Services & {
	sessionRuntime: SessionManager
	/** Bearer token for authenticating HTTP requests. Optional - only used in worker mode. */
	agentToken?: string
	/** File preprocessor registry for upload routes. Optional - only available when uploads plugin is configured. */
	preprocessorRegistry?: PreprocessorRegistry
}

/**
 * Environment type for Hono app with injected services.
 */
export type AppEnv = {
	Variables: {
		services: AppServices
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
export function getServices(c: AppContext): AppServices {
	return c.get('services')
}

/**
 * Creates the Hono application with all middleware and routes.
 */
export function createApp(services: AppServices): Hono<AppEnv> {
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

	// Activity status for DO polling (protected)
	// Returns lastActivityAt timestamp for the caller to determine if agent is active
	app.get('/status', bearerAuth, async (c) => {
		const { sessionRuntime } = getServices(c)
		const stats = await sessionRuntime.getStats()

		return c.json({
			lastActivityAt: stats.lastActivityAt,
			stats: {
				sessionCount: stats.sessionCount,
				pendingAgents: stats.pendingAgents,
				processingAgents: stats.processingAgents,
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
	const rpcRoutes = createRpcRoutes()
	const uploadRoutes = createUploadRoutes()
	const resourceRoutes = createResourceRoutes()
	const fileRoutes = createFileRoutes()

	app.use('/rpc/*', bearerAuth)
	app.use('/sessions/*', bearerAuth)
	app.route('/rpc', rpcRoutes)
	app.route('/sessions', uploadRoutes)
	app.route('/sessions', resourceRoutes)
	app.route('/sessions', fileRoutes)

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
