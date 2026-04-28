/**
 * Upload Routes
 *
 * Multipart file upload endpoint for session attachments.
 * Separate from RPC as multipart is more efficient for binary data.
 * Business logic delegated to uploads plugin.
 */

import { Hono } from 'hono'
import { SessionId } from '~/core/sessions/schema.js'
import { type AppContext, type AppEnv, getServices } from '../app.js'

// ============================================================================
// Routes
// ============================================================================

/**
 * Creates upload routes.
 */
export function createUploadRoutes(): Hono<AppEnv> {
	const app = new Hono<AppEnv>()

	/**
	 * POST /sessions/:sessionId/upload
	 *
	 * Upload a file for later attachment to a message.
	 * The file is processed and stored, but no message is sent.
	 * Pending uploads are automatically dequeued by the uploads plugin during agent inference.
	 *
	 * Form fields:
	 * - file (required): The file to upload
	 *
	 * Response:
	 * - 201: { uploadId, status, extractedContent? }
	 * - 400: Validation error
	 * - 404: Session not found
	 */
	app.post('/:sessionId/upload', async (c: AppContext) => {
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

		// 2. Parse multipart form data (transport concern — stays in HTTP layer)
		let body: Record<string, string | File>
		try {
			body = await c.req.parseBody()
		} catch {
			return c.json(
				{ error: { type: 'parse_error', message: 'Failed to parse multipart form data' } },
				400,
			)
		}

		const file = body.file

		// 3. Validate file presence
		if (!file || !(file instanceof File)) {
			return c.json(
				{ error: { type: 'validation_error', message: 'No file provided' } },
				400,
			)
		}

		// 4. Convert to Buffer and delegate to uploads plugin
		const fileBuffer = Buffer.from(await file.arrayBuffer())

		const result = await sessionRuntime.callPluginMethod(sessionId, 'uploads.upload', {
			sessionId: String(sessionId),
			filename: file.name,
			mimeType: file.type,
			size: file.size,
			fileBuffer,
		})

		if (!result.ok) {
			return c.json(
				{ error: { type: result.error.type, message: result.error.type === 'validation_error' ? result.error.message : 'Upload failed' } },
				400,
			)
		}

		const uploadResult = result.value
		if (typeof uploadResult !== 'object' || uploadResult === null || !('uploadId' in uploadResult)) {
			return c.json(
				{ error: { type: 'internal_error', message: 'Plugin did not return expected result' } },
				500,
			)
		}

		logger.info('File uploaded successfully', {
			sessionId,
			uploadId: uploadResult.uploadId,
			filename: file.name,
			mimeType: file.type,
			size: file.size,
		})

		return c.json(
			{
				uploadId: uploadResult.uploadId,
				status: 'status' in uploadResult ? uploadResult.status : 'ready',
				extractedContent: 'extractedContent' in uploadResult ? uploadResult.extractedContent : undefined,
			},
			201,
		)
	})

	/**
	 * POST /sessions/:sessionId/upload-from-url
	 *
	 * Download a file from a URL and process it as an upload.
	 * Used by the worker to inject resource files into sessions.
	 *
	 * JSON body:
	 * - url (required): URL to download the file from
	 * - filename (required): Original filename
	 * - mimeType (required): MIME type of the file
	 */
	app.post('/:sessionId/upload-from-url', async (c: AppContext) => {
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
		let body: { url: string; filename: string; mimeType: string }
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
		let response: Response
		try {
			response = await fetch(body.url, { signal: AbortSignal.timeout(30_000) })
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

		// 4. Read response with size limit (10MB)
		const maxSize = 10 * 1024 * 1024
		const contentLength = response.headers.get('Content-Length')
		if (contentLength && Number.parseInt(contentLength, 10) > maxSize) {
			return c.json(
				{ error: { type: 'validation_error', message: 'File too large (max 10MB)' } },
				400,
			)
		}

		const arrayBuffer = await response.arrayBuffer()
		if (arrayBuffer.byteLength > maxSize) {
			return c.json(
				{ error: { type: 'validation_error', message: 'File too large (max 10MB)' } },
				400,
			)
		}

		const fileBuffer = Buffer.from(arrayBuffer)

		// 5. Call uploads plugin (same path as multipart upload)
		const result = await sessionRuntime.callPluginMethod(sessionId, 'uploads.upload', {
			sessionId: String(sessionId),
			filename: body.filename,
			mimeType: body.mimeType,
			size: fileBuffer.length,
			fileBuffer,
		})

		if (!result.ok) {
			return c.json(
				{ error: { type: result.error.type, message: result.error.type === 'validation_error' ? result.error.message : 'Upload failed' } },
				400,
			)
		}

		const uploadResult = result.value
		if (typeof uploadResult !== 'object' || uploadResult === null || !('uploadId' in uploadResult)) {
			return c.json(
				{ error: { type: 'internal_error', message: 'Plugin did not return expected result' } },
				500,
			)
		}

		logger.info('File uploaded from URL successfully', {
			sessionId,
			uploadId: uploadResult.uploadId,
			filename: body.filename,
			mimeType: body.mimeType,
			size: fileBuffer.length,
		})

		return c.json(
			{
				uploadId: uploadResult.uploadId,
				status: 'status' in uploadResult ? uploadResult.status : 'ready',
				extractedContent: 'extractedContent' in uploadResult ? uploadResult.extractedContent : undefined,
			},
			201,
		)
	})

	/**
	 * GET /sessions/:sessionId/uploads/:uploadId/:filename
	 *
	 * Download an uploaded file.
	 * This stays in the HTTP layer as it returns binary data (not a plugin method concern).
	 */
	app.get('/:sessionId/uploads/:uploadId/:filename', async (c: AppContext) => {
		const { dataFileStore } = getServices(c)
		const sessionId = c.req.param('sessionId')!
		const uploadId = c.req.param('uploadId')!
		const filename = c.req.param('filename')!

		const uploadStore = dataFileStore.scoped(`sessions/${sessionId}/uploads/${uploadId}`)
		const readResult = await uploadStore.read(filename, { type: 'buffer' })

		if (!readResult.ok) {
			return c.json(
				{ error: { type: 'not_found', message: 'File not found' } },
				404,
			)
		}

		// Detect MIME type
		const ext = filename.split('.').pop()?.toLowerCase()
		const mimeTypes: Record<string, string> = {
			jpg: 'image/jpeg',
			jpeg: 'image/jpeg',
			png: 'image/png',
			gif: 'image/gif',
			webp: 'image/webp',
			svg: 'image/svg+xml',
			pdf: 'application/pdf',
			txt: 'text/plain',
			md: 'text/markdown',
			json: 'application/json',
		}
		const contentType = ext ? mimeTypes[ext] ?? 'application/octet-stream' : 'application/octet-stream'

		return new Response(readResult.value, {
			headers: {
				'Content-Type': contentType,
				'Content-Length': readResult.value.length.toString(),
				'Content-Disposition': `inline; filename="${filename}"`,
			},
		})
	})

	return app
}
