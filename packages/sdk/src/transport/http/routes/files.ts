/**
 * File Proxy Routes
 *
 * Serves session files (e.g. screenshots from tools) via HTTP.
 * Used by the debug UI to display images from LLM call logs.
 */

import { Hono } from 'hono'
import { resolve } from 'node:path'
import { getMimeType, preventTraversal } from '~/plugins/filesystem/listing.js'
import { SessionId } from '~/core/sessions/schema.js'
import { type AppContext, type AppEnv, getServices } from '../context.js'

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
	return c.req.path.slice(idx + marker.length + 2)
}

async function serveFile(c: AppContext, filePath: string): Promise<Response> {
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

	const contentType = getMimeType(filePath)

	return new Response(data, {
		headers: {
			'Content-Type': contentType,
			'Content-Length': data.length.toString(),
			'Cache-Control': 'public, max-age=3600',
		},
	})
}

async function resolveWorkspaceDir(c: AppContext, sessionId: string): Promise<string | null> {
	const { sessionRuntime } = getServices(c)
	const result = await sessionRuntime.getSession(SessionId(sessionId))
	if (!result.ok) return null
	return result.value.state.workspaceDir ?? null
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
		const { config } = getServices(c)
		const sessionId = c.req.param('sessionId')!
		const filePath = extractWildcardPath(c, 'files')

		if (!filePath) {
			return c.json(
				{ error: { type: 'validation_error', message: 'File path is required' } },
				400,
			)
		}

		const sessionDir = resolve(config.dataPath, 'sessions', sessionId)
		const resolvedPath = preventTraversal(sessionDir, filePath)

		if (!resolvedPath) {
			return c.json(
				{ error: { type: 'forbidden', message: 'Path traversal not allowed' } },
				403,
			)
		}

		return serveFile(c, resolvedPath)
	})

	// --- Serve workspace file ---
	app.get('/:sessionId/workspace/*', async (c: AppContext) => {
		const sessionId = c.req.param('sessionId')!
		const filePath = extractWildcardPath(c, 'workspace')

		if (!filePath) {
			return c.json(
				{ error: { type: 'validation_error', message: 'File path is required' } },
				400,
			)
		}

		const workspaceDir = await resolveWorkspaceDir(c, sessionId)
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

		return serveFile(c, resolvedPath)
	})

	return app
}
