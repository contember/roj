/**
 * Resource injection routes.
 *
 * POST /sessions/:sessionId/inject-resource
 * Downloads a file from a URL and injects it directly into the session workspace
 * (ZIP files are extracted, other files are copied). Used by the worker to inject
 * organization resources into sessions, bypassing the uploads/attachment pipeline.
 */

import { Hono } from 'hono'
import type { AppContext, AppEnv } from '../app.js'
import { getServices } from '../app.js'
import { SessionId } from '~/core/sessions/schema.js'

export function createResourceRoutes(): Hono<AppEnv> {
	const app = new Hono<AppEnv>()

	app.post('/:sessionId/inject-resource', async (c: AppContext) => {
		const { sessionRuntime, logger } = getServices(c)
		const sessionId = SessionId(c.req.param('sessionId')!)

		// 1. Verify session exists
		const sessionResult = await sessionRuntime.getSession(sessionId)
		if (!sessionResult.ok) {
			return c.json(
				{ error: { type: 'session_not_found', message: `Session not found: ${sessionId}` } },
				404,
			)
		}

		// 2. Parse JSON body
		let body: { url: string; filename: string; mimeType: string; metadata?: { slug?: string; name?: string } }
		try {
			body = await c.req.json()
		} catch {
			return c.json(
				{ error: { type: 'parse_error', message: 'Failed to parse JSON body' } },
				400,
			)
		}

		if (!body.url || !body.filename || !body.mimeType) {
			return c.json(
				{ error: { type: 'validation_error', message: 'Missing required fields: url, filename, mimeType' } },
				400,
			)
		}

		// 3. Fetch URL
		const maxSize = 50 * 1024 * 1024 // 50MB
		let response: Response
		try {
			response = await fetch(body.url, { signal: AbortSignal.timeout(120_000) })
		} catch (err) {
			return c.json(
				{ error: { type: 'fetch_error', message: `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}` } },
				400,
			)
		}

		if (!response.ok) {
			return c.json(
				{ error: { type: 'fetch_error', message: `URL returned ${response.status}` } },
				400,
			)
		}

		// 4. Read response with size limit
		const contentLength = response.headers.get('Content-Length')
		if (contentLength && Number.parseInt(contentLength, 10) > maxSize) {
			return c.json(
				{ error: { type: 'validation_error', message: 'File too large (max 50MB)' } },
				400,
			)
		}

		const arrayBuffer = await response.arrayBuffer()
		if (arrayBuffer.byteLength > maxSize) {
			return c.json(
				{ error: { type: 'validation_error', message: 'File too large (max 50MB)' } },
				400,
			)
		}

		const fileBuffer = Buffer.from(arrayBuffer)

		// 5. Call resources plugin
		const result = await sessionRuntime.callPluginMethod(sessionId, 'resources.inject', {
			sessionId: String(sessionId),
			filename: body.filename,
			mimeType: body.mimeType,
			size: fileBuffer.length,
			fileBuffer,
			metadata: body.metadata,
		})

		if (!result.ok) {
			logger.error('Resource injection failed', undefined, { sessionId: String(sessionId), error: result.error })
			return c.json(
				{ error: { type: result.error.type, message: 'Resource injection failed' } },
				400,
			)
		}

		const injectResult = result.value as { resourceId: string; paths: string[] }

		return c.json({
			ok: true,
			resourceId: injectResult.resourceId,
			paths: injectResult.paths,
		}, 201)
	})

	return app
}
