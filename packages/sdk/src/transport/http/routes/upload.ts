/**
 * Upload Routes
 *
 * Multipart file upload endpoint for session attachments.
 * Separate from RPC as multipart is more efficient for binary data.
 * Business logic delegated to uploads plugin.
 */

import { invalidSessionId, parseError, sessionNotFound } from '../responses.js'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { DomainError } from '~/core/errors.js'
import { parseSessionId } from '~/core/sessions/schema.js'
import { preventTraversal } from '~/plugins/filesystem/listing.js'
import { type AppContext, type AppEnv, getServices } from '../context.js'
import { readBodyWithLimit, safeFetch } from '../fetch-guard.js'
import { resolveCanonicalPath } from '../path-containment.js'

/** A plugin error carries its own status; this route only ever speaks 400 or 500. */
const pluginErrorStatus = (error: DomainError): ContentfulStatusCode => (error.httpStatus >= 500 ? 500 : 400)

// ============================================================================
// Download helpers
// ============================================================================

/**
 * Characters an upload id may contain.
 *
 * Same reasoning as `SESSION_ID_PATTERN`: the id is interpolated straight into a
 * filesystem path, and `%2F` in it only decodes at `c.req.param`. Generated ids
 * are UUIDv7, which fits.
 */
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const UPLOAD_MIME_TYPES: Record<string, string> = {
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

/** True when the value names one entry and cannot walk anywhere. */
function isBasename(value: string): boolean {
	if (value === '' || value === '.' || value === '..') return false
	return !/[/\\\0]/.test(value)
}

/**
 * `Content-Disposition` filename, as an ASCII fallback plus the RFC 5987 form.
 *
 * `new Response` throws a TypeError on a header value that is not Latin-1, so a
 * bare `filename="<uploaded name>"` makes every CJK or emoji upload a 500 rather
 * than a download. Escaping alone does not fix that — the name has to be encoded.
 */
function contentDispositionFilename(filename: string): string {
	const ascii = [...filename]
		.map(char => (char >= ' ' && char <= '~' && char !== '"' && char !== '\\' ? char : '_'))
		.join('')
	// `encodeURIComponent` leaves `'()*` alone, but RFC 5987 attr-char does not allow them.
	const encoded = encodeURIComponent(filename).replace(
		/['()*]/g,
		char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	)
	return `filename="${ascii}"; filename*=UTF-8''${encoded}`
}

const invalidPathSegment = (c: AppContext, message: string) =>
	c.json({ error: { type: 'validation_error', message } }, 400)

const forbiddenPath = (c: AppContext, message: string) =>
	c.json({ error: { type: 'forbidden', message } }, 403)

const uploadNotFound = (c: AppContext) =>
	c.json({ error: { type: 'not_found', message: 'File not found' } }, 404)

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
		const sessionIdResult = parseSessionId(c.req.param('sessionId')!)
		if (!sessionIdResult.ok) return invalidSessionId(c, sessionIdResult.error)
		const sessionId = sessionIdResult.value

		const leaseResult = await sessionRuntime.acquireSessionLease(sessionId, 'http:upload')
		if (!leaseResult.ok) {
			return sessionNotFound(c, sessionId)
		}
		try {
			// 2. Parse multipart form data (transport concern — stays in HTTP layer)
			let body: Record<string, string | File>
			try {
				body = await c.req.parseBody()
			} catch {
				return parseError(c, 'Failed to parse multipart form data')
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
					pluginErrorStatus(result.error),
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
		} finally {
			leaseResult.value.release()
		}
	})

	/**
	 * POST /sessions/:sessionId/upload-async
	 *
	 * Async variant of /upload — returns immediately with status: 'processing'
	 * and continues preprocessing in the background. Clients should listen for
	 * the `uploads.uploadStatusChanged` notification to learn when the upload
	 * becomes `ready` or `failed`, or fall back to polling `uploads.listPending`.
	 *
	 * Form fields: same as /upload.
	 *
	 * Response:
	 * - 202: { uploadId, status: 'processing' }
	 * - 400: Validation error
	 * - 404: Session not found
	 */
	app.post('/:sessionId/upload-async', async (c: AppContext) => {
		const { sessionRuntime, logger } = getServices(c)
		const sessionIdResult = parseSessionId(c.req.param('sessionId')!)
		if (!sessionIdResult.ok) return invalidSessionId(c, sessionIdResult.error)
		const sessionId = sessionIdResult.value

		const leaseResult = await sessionRuntime.acquireSessionLease(sessionId, 'http:upload-async')
		if (!leaseResult.ok) {
			return sessionNotFound(c, sessionId)
		}
		try {
			let body: Record<string, string | File>
			try {
				body = await c.req.parseBody()
			} catch {
				return parseError(c, 'Failed to parse multipart form data')
			}

			const file = body.file
			if (!file || !(file instanceof File)) {
				return c.json(
					{ error: { type: 'validation_error', message: 'No file provided' } },
					400,
				)
			}

			const fileBuffer = Buffer.from(await file.arrayBuffer())

			const result = await sessionRuntime.callPluginMethod(sessionId, 'uploads.uploadAsync', {
				sessionId: String(sessionId),
				filename: file.name,
				mimeType: file.type,
				size: file.size,
				fileBuffer,
			})

			if (!result.ok) {
				return c.json(
					{ error: { type: result.error.type, message: result.error.type === 'validation_error' ? result.error.message : 'Upload failed' } },
					pluginErrorStatus(result.error),
				)
			}

			const uploadResult = result.value
			if (typeof uploadResult !== 'object' || uploadResult === null || !('uploadId' in uploadResult)) {
				return c.json(
					{ error: { type: 'internal_error', message: 'Plugin did not return expected result' } },
					500,
				)
			}

			logger.info('File upload accepted (async)', {
				sessionId,
				uploadId: uploadResult.uploadId,
				filename: file.name,
				mimeType: file.type,
				size: file.size,
			})

			return c.json(
				{
					uploadId: uploadResult.uploadId,
					status: 'status' in uploadResult ? uploadResult.status : 'processing',
				},
				202,
			)
		} finally {
			leaseResult.value.release()
		}
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
		const { sessionRuntime, logger, config } = getServices(c)
		const sessionIdResult = parseSessionId(c.req.param('sessionId')!)
		if (!sessionIdResult.ok) return invalidSessionId(c, sessionIdResult.error)
		const sessionId = sessionIdResult.value

		const leaseResult = await sessionRuntime.acquireSessionLease(sessionId, 'http:upload-from-url')
		if (!leaseResult.ok) {
			return sessionNotFound(c, sessionId)
		}
		try {
			// 2. Parse JSON body
			let body: { url: string; filename: string; mimeType: string }
			try {
				body = await c.req.json()
			} catch {
				return parseError(c, 'Failed to parse JSON body')
			}

			if (!body.url || !body.filename || !body.mimeType) {
				return c.json(
					{ error: { type: 'validation_error', message: 'Missing required fields: url, filename, mimeType' } },
					400,
				)
			}

			// 3. Fetch URL — guarded, redirects included (twin of inject-resource)
			const fetched = await safeFetch(body.url, { timeoutMs: 30_000, allowedHosts: config.remoteFetchAllowedHosts })
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

			// 4. Read response with size limit (10MB), capped on real bytes rather than the declared length
			const maxSize = 10 * 1024 * 1024
			const contentLength = response.headers.get('Content-Length')
			if (contentLength && Number.parseInt(contentLength, 10) > maxSize) {
				return c.json(
					{ error: { type: 'validation_error', message: 'File too large (max 10MB)' } },
					400,
				)
			}

			const fileBuffer = await readBodyWithLimit(response, maxSize)
			if (!fileBuffer) {
				return c.json(
					{ error: { type: 'validation_error', message: 'File too large (max 10MB)' } },
					400,
				)
			}

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
					pluginErrorStatus(result.error),
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
		} finally {
			leaseResult.value.release()
		}
	})

	/**
	 * GET /sessions/:sessionId/uploads/:uploadId/:filename
	 *
	 * Download an uploaded file.
	 * This stays in the HTTP layer as it returns binary data (not a plugin method concern).
	 */
	app.get('/:sessionId/uploads/:uploadId/:filename', async (c: AppContext) => {
		const { dataFileStore, platform } = getServices(c)
		const sessionIdResult = parseSessionId(c.req.param('sessionId')!)
		if (!sessionIdResult.ok) return invalidSessionId(c, sessionIdResult.error)
		const sessionId = sessionIdResult.value

		// Both params are joined into a path, and `%2F` only decodes here — so both
		// are checked before anything derives a path from them, as the session id is.
		const uploadId = c.req.param('uploadId')!
		if (!UPLOAD_ID_PATTERN.test(uploadId)) return invalidPathSegment(c, 'Invalid upload id')

		const filename = c.req.param('filename')!
		if (!isBasename(filename)) return invalidPathSegment(c, 'Invalid filename')

		// `realPath` returns a Result where `scoped()` throws, so hostile input can never 500 here.
		const uploadDirResult = dataFileStore.realPath(`sessions/${sessionId}/uploads/${uploadId}`)
		if (!uploadDirResult.ok) return invalidPathSegment(c, 'Invalid upload id')
		const uploadDir = uploadDirResult.value

		const requestedPath = preventTraversal(uploadDir, filename)
		if (!requestedPath) return forbiddenPath(c, 'Path traversal not allowed')

		// The agent can write into the session directory, so an upload entry may be a symlink out of it.
		const canonicalPath = await resolveCanonicalPath(c, uploadDir, requestedPath)
		if (canonicalPath.status === 'forbidden') return forbiddenPath(c, 'Symlink traversal not allowed')
		if (canonicalPath.status === 'not_found') return uploadNotFound(c)

		let data: Buffer
		try {
			data = await platform.fs.readFile(canonicalPath.path)
		} catch {
			return uploadNotFound(c)
		}

		const ext = filename.split('.').pop()?.toLowerCase()
		const contentType = ext ? UPLOAD_MIME_TYPES[ext] ?? 'application/octet-stream' : 'application/octet-stream'

		return new Response(data, {
			headers: {
				'Content-Type': contentType,
				'Content-Length': data.length.toString(),
				'Content-Disposition': `inline; ${contentDispositionFilename(filename)}`,
				// The body is whatever was uploaded — never let the browser sniff or execute it.
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy': "default-src 'none'; sandbox",
			},
		})
	})

	return app
}
