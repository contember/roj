/**
 * File Proxy Routes
 *
 * Serves session files (e.g. screenshots from tools) via HTTP.
 * Used by the debug UI to display images from LLM call logs.
 */

import { Hono } from 'hono'
import { resolve } from 'node:path'
import { getMimeType, preventTraversal } from '~/plugins/filesystem/listing.js'
import { parseSessionId, type SessionId } from '~/core/sessions/schema.js'
import { type AppContext, type AppEnv, getServices } from '../context.js'
import { resolveCanonicalPath } from '../path-containment.js'
import { invalidSessionId } from '../responses.js'

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract the wildcard path suffix from a request.
 *
 * Hono's c.req.param('*') doesn't work in sub-routers mounted via app.route(),
 * so we extract it from c.req.path by finding the marker segment and taking everything after it.
 */
function extractWildcardPath(c: AppContext, marker: string): string {
	const idx = c.req.path.indexOf(`/${marker}/`)
	if (idx === -1) return ''
	try {
		return decodeURIComponent(c.req.path.slice(idx + marker.length + 2))
	} catch {
		return ''
	}
}

async function serveFile(c: AppContext, filePath: string, mimePath: string): Promise<Response> {
	const { platform } = getServices(c)
	let data: Buffer
	try {
		data = await platform.fs.readFile(filePath)
	} catch {
		return c.json(
			{ error: { type: 'not_found', message: 'File not found' } },
			404,
		)
	}

	const contentType = getMimeType(mimePath)

	return new Response(data, {
		headers: {
			'Content-Type': contentType,
			'Content-Length': data.length.toString(),
			'Cache-Control': 'public, max-age=3600',
			// Bodies here are attacker-influenced (uploads, injected resources, anything the agent writes).
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'; sandbox",
		},
	})
}

async function resolveWorkspaceDir(c: AppContext, sessionId: SessionId): Promise<string | null> {
	const { sessionRuntime } = getServices(c)
	const result = await sessionRuntime.acquireSessionLease(sessionId, 'http:files')
	if (!result.ok) return null
	try {
		return result.value.session.state.workspaceDir ?? null
	} finally {
		result.value.release()
	}
}

// ============================================================================
// Routes
// ============================================================================

/**
 * Creates file proxy routes.
 *
 * GET /:sessionId/files/*path              - Serve session file
 * GET /:sessionId/workspace/*path          - Serve workspace file
 */
export function createFileRoutes(): Hono<AppEnv> {
	const app = new Hono<AppEnv>()

	// --- Serve session file ---
	app.get('/:sessionId/files/*', async (c: AppContext) => {
		const { dataFileStore } = getServices(c)
		const sessionIdResult = parseSessionId(c.req.param('sessionId')!)
		if (!sessionIdResult.ok) return invalidSessionId(c, sessionIdResult.error)
		const filePath = extractWildcardPath(c, 'files')

		if (!filePath) {
			return c.json(
				{ error: { type: 'validation_error', message: 'File path is required' } },
				400,
			)
		}

		// Build the root through the store's guard: `resolve(dataPath, ...)` would happily
		// escape the data root on an id Hono decoded from `%2F`.
		const sessionDirResult = dataFileStore.realPath(`sessions/${sessionIdResult.value}`)
		if (!sessionDirResult.ok) {
			return c.json(
				{ error: { type: 'forbidden', message: 'Path traversal not allowed' } },
				403,
			)
		}

		const sessionDir = sessionDirResult.value
		const resolvedPath = preventTraversal(sessionDir, filePath)

		if (!resolvedPath) {
			return c.json(
				{ error: { type: 'forbidden', message: 'Path traversal not allowed' } },
				403,
			)
		}

		const canonicalPath = await resolveCanonicalPath(c, sessionDir, resolvedPath)
		if (canonicalPath.status === 'forbidden') {
			return c.json(
				{ error: { type: 'forbidden', message: 'Symlink traversal not allowed' } },
				403,
			)
		}
		if (canonicalPath.status === 'not_found') {
			return c.json(
				{ error: { type: 'not_found', message: 'File not found' } },
				404,
			)
		}

		return serveFile(c, canonicalPath.path, resolvedPath)
	})

	// --- Serve workspace file ---
	app.get('/:sessionId/workspace/*', async (c: AppContext) => {
		const sessionIdResult = parseSessionId(c.req.param('sessionId')!)
		if (!sessionIdResult.ok) return invalidSessionId(c, sessionIdResult.error)
		const filePath = extractWildcardPath(c, 'workspace')

		if (!filePath) {
			return c.json(
				{ error: { type: 'validation_error', message: 'File path is required' } },
				400,
			)
		}

		const workspaceDir = await resolveWorkspaceDir(c, sessionIdResult.value)
		if (!workspaceDir) {
			return c.json(
				{ error: { type: 'not_found', message: 'No workspace configured for this session' } },
				404,
			)
		}

		const resolvedPath = preventTraversal(resolve(workspaceDir), filePath)
		if (!resolvedPath) {
			return c.json(
				{ error: { type: 'forbidden', message: 'Path traversal not allowed' } },
				403,
			)
		}

		const canonicalPath = await resolveCanonicalPath(c, workspaceDir, resolvedPath)
		if (canonicalPath.status === 'forbidden') {
			return c.json(
				{ error: { type: 'forbidden', message: 'Symlink traversal not allowed' } },
				403,
			)
		}
		if (canonicalPath.status === 'not_found') {
			return c.json(
				{ error: { type: 'not_found', message: 'File not found' } },
				404,
			)
		}

		return serveFile(c, canonicalPath.path, resolvedPath)
	})

	return app
}
