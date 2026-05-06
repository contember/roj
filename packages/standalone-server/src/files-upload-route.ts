/**
 * POST /api/v1/files/upload — multipart endpoint matching the `@roj-ai/client/platform.files.upload`
 * two-phase contract:
 *
 *   1. Preflight with `contentHash`, `filename`, `mimeType` only. If we already have
 *      the bytes (sha-256 match), respond `{ ok, fileId, ..., deduped: true }`.
 *      Otherwise respond 409 `{ error: 'file-required' }`.
 *   2. Retry with the same fields plus a `file` blob. We persist the bytes,
 *      record the file, and respond `{ ok, fileId, ..., deduped: false }`.
 *
 * No bearer auth (standalone is open) — but we accept and ignore an
 * `Authorization: Bearer …` header so client code copy-pasted from the platform
 * keeps working.
 */

import type { Context } from 'hono'
import type { LocalRegistry } from './local-registry.js'

interface Deps {
	registry: LocalRegistry
}

export function createFilesUploadRoute(deps: Deps) {
	return async (c: Context) => {
		let form: FormData
		try {
			form = await c.req.formData()
		} catch {
			return c.json({ ok: false, error: 'invalid_multipart' }, 400)
		}

		const contentHash = form.get('contentHash')
		const filename = form.get('filename')
		const mimeType = form.get('mimeType')
		if (typeof contentHash !== 'string' || typeof filename !== 'string' || typeof mimeType !== 'string') {
			return c.json(
				{ ok: false, error: 'invalid_form' },
				400,
			)
		}

		const file = form.get('file')
		const buffer = file && typeof file !== 'string' && 'arrayBuffer' in file
			? Buffer.from(await file.arrayBuffer())
			: undefined

		const result = await deps.registry.uploadFile({ buffer, filename, mimeType, contentHash })

		if ('error' in result) {
			// Preflight miss — client retries with body.
			return c.json({ ok: false, error: result.error }, 409)
		}

		return c.json({
			ok: true,
			fileId: result.fileId,
			filename: result.filename,
			mimeType: result.mimeType,
			size: result.size,
			r2Key: '',
			deduped: result.deduped,
		})
	}
}
