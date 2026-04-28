/**
 * Error Handler Middleware
 *
 * Handles all errors thrown during request processing:
 * - HTTPException from Hono
 * - Domain errors from business logic (self-describing with httpStatus)
 * - Validation errors from Zod
 * - Unknown errors (logged and returned as 500)
 */

import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { isDomainError } from '~/core/errors.js'
import type { AppEnv } from '../app.js'

/**
 * Global error handler for Hono app.
 */
export const errorHandler = (error: Error, c: Context<AppEnv>) => {
	const services = c.get('services')
	const logger = services?.logger

	// HTTPException (from Hono)
	if (error instanceof HTTPException) {
		return c.json(
			{
				error: {
					type: 'http_error',
					message: error.message,
				},
			},
			error.status,
		)
	}

	// Domain errors (self-describing — carry their own httpStatus)
	if (isDomainError(error)) {
		return c.json(
			{ error: { type: error.type, message: error.message } },
			error.httpStatus as ContentfulStatusCode,
		)
	}

	// Validation errors (from Zod)
	if (error.name === 'ZodError') {
		const zodError = error as { issues?: unknown }
		return c.json(
			{
				error: {
					type: 'validation_error',
					message: 'Invalid request',
					details: zodError.issues,
				},
			},
			400,
		)
	}

	// Unknown errors
	if (logger) {
		logger.error('Unhandled error', error)
	} else {
		console.error('Unhandled error (no logger available):', error)
	}

	return c.json(
		{
			error: {
				type: 'internal_error',
				message: 'Internal server error',
			},
		},
		500,
	)
}
