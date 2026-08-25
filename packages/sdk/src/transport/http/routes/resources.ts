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
import { parseSessionId } from '~/core/sessions/schema.js'
import { ResourceBasenameSchema } from '~/plugins/resources/filename.js'
import type { AppContext, AppEnv } from '../context.js'
import { getServices } from '../context.js'
import { readBodyWithLimit, safeFetch } from '../fetch-guard.js'
import { invalidSessionId, parseError, sessionNotFound } from '../responses.js'

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
		const { sessionRuntime, logger, config } = getServices(c)
		const sessionIdResult = parseSessionId(c.req.param('sessionId')!)
		if (!sessionIdResult.ok) return invalidSessionId(c, sessionIdResult.error)
		const sessionId = sessionIdResult.value

		const leaseResult = await sessionRuntime.acquireSessionLease(sessionId, 'http:inject-resource')
		if (!leaseResult.ok) {
			return sessionNotFound(c, sessionId)
		}
		try {
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

			// 3. Fetch URL — guarded, redirects included (twin of upload-from-url)
			const maxSize = 50 * 1024 * 1024 // 50MB
			const fetched = await safeFetch(body.url, { timeoutMs: 120_000, allowedHosts: config.remoteFetchAllowedHosts })
			if (!fetched.ok) {
				return c.json(
					{ error: { type: fetched.error.type, message: fetched.error.message } },
					400,
				)
			}
			const response = fetched.value

			if (!response.ok) {
				return c.json(
					{ error: { type: 'fetch_error', message: `URL returned ${response.status}` } },
					400,
				)
			}

			// 4. Read response with size limit, capped on real bytes rather than the declared length
			const contentLength = response.headers.get('Content-Length')
			if (contentLength && Number.parseInt(contentLength, 10) > maxSize) {
				return c.json(
					{ error: { type: 'validation_error', message: 'File too large (max 50MB)' } },
					400,
				)
			}

			const fileBuffer = await readBodyWithLimit(response, maxSize)
			if (!fileBuffer) {
				return c.json(
					{ error: { type: 'validation_error', message: 'File too large (max 50MB)' } },
					400,
				)
			}

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
		} finally {
			leaseResult.value.release()
		}
	})

	return app
}
