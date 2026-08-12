/**
 * Resource injection routes.
 *
 * POST /sessions/:sessionId/inject-resource
 * Downloads a file from a URL and injects it directly into the session workspace
 * (ZIP files are extracted, other files are copied). Used by the worker to inject
 * organization resources into sessions, bypassing the uploads/attachment pipeline.
 */

import { Hono } from 'hono'
import z from 'zod/v4'
import { SessionId } from '~/core/sessions/schema.js'
import { ResourceBasenameSchema } from '~/plugins/resources/filename.js'
import type { AppContext, AppEnv } from '../context.js'
import { getServices } from '../context.js'
import { parseError, sessionNotFound } from '../responses.js'

const ResourceRequestSchema = z.object({
	url: z.string().min(1),
	filename: z.string().min(1),
	mimeType: z.string().min(1),
	metadata: z.object({
		slug: z.string().optional(),
		name: z.string().optional(),
	}).optional(),
}).superRefine((body, refinement) => {
	if (body.mimeType !== 'application/zip' && !ResourceBasenameSchema.safeParse(body.filename).success) {
		refinement.addIssue({
			code: 'custom',
			path: ['filename'],
			message: 'Resource filename must be a basename',
		})
	}
})

const ResourceInjectResultSchema = z.object({
	resourceId: z.string(),
	paths: z.array(z.string()),
})

export function createResourceRoutes(): Hono<AppEnv> {
	const app = new Hono<AppEnv>()

	app.post('/:sessionId/inject-resource', async (c: AppContext) => {
		const { sessionRuntime, logger } = getServices(c)
		const sessionId = SessionId(c.req.param('sessionId')!)

		// 1. Verify session exists
		const sessionResult = await sessionRuntime.getSession(sessionId)
		if (!sessionResult.ok) {
			return sessionNotFound(c, sessionId)
		}

		// 2. Parse JSON body
		let rawBody: unknown
		try {
			rawBody = await c.req.json()
		} catch {
			return parseError(c, 'Failed to parse JSON body')
		}

		const parsedBody = ResourceRequestSchema.safeParse(rawBody)
		if (!parsedBody.success) {
			return c.json(
				{ error: { type: 'validation_error', message: parsedBody.error.message } },
				400,
			)
		}
		const body = parsedBody.data

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

		const injectResult = ResourceInjectResultSchema.safeParse(result.value)
		if (!injectResult.success) {
			logger.error('Resource injection returned an invalid result', undefined, { sessionId: String(sessionId) })
			return c.json(
				{ error: { type: 'internal_error', message: 'Resource injection returned an invalid result' } },
				500,
			)
		}

		return c.json({
			ok: true,
			resourceId: injectResult.data.resourceId,
			paths: injectResult.data.paths,
		}, 201)
	})

	return app
}
