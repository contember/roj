/**
 * Bearer Auth Middleware
 *
 * Validates Authorization: Bearer <token> header against configured agentToken.
 * Only active when agentToken is configured (worker mode).
 */

import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app.js'

/**
 * Creates bearer auth middleware.
 * Returns 401 if token is invalid or missing (when required).
 *
 * @param expectedToken - The expected bearer token. If undefined, middleware is a no-op.
 */
export function createBearerAuth(expectedToken: string | undefined): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		// Skip auth if no token configured (local dev mode)
		if (!expectedToken) {
			return next()
		}

		const authHeader = c.req.header('Authorization')
		if (!authHeader) {
			return c.json({ error: { type: 'unauthorized', message: 'Missing Authorization header' } }, 401)
		}

		const [scheme, token] = authHeader.split(' ')
		if (scheme !== 'Bearer' || !token) {
			return c.json({ error: { type: 'unauthorized', message: 'Invalid Authorization header format' } }, 401)
		}

		if (token !== expectedToken) {
			return c.json({ error: { type: 'unauthorized', message: 'Invalid token' } }, 401)
		}

		return next()
	}
}
