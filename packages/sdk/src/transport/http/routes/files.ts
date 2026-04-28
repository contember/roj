/**
 * File Proxy Routes
 *
 * Serves session files (e.g. screenshots from tools) via HTTP.
 * Used by the debug UI to display images from LLM call logs.
 */

import { Hono } from 'hono'
import { extname, resolve } from 'node:path'
import { SessionId } from '~/core/sessions/schema.js'
import { type AppContext, type AppEnv, getServices } from '../app.js'

// ============================================================================
// Constants
// ============================================================================

/** Known MIME types for specific extensions. */
const MIME_TYPES: Record<string, string> = {
	// Images
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.bmp': 'image/bmp',
	'.avif': 'image/avif',
	// Video
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mov': 'video/quicktime',
	// Audio
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	// Documents
	'.pdf': 'application/pdf',
	// Data/markup
	'.json': 'application/json',
	'.html': 'text/html',
	'.css': 'text/css',
	'.js': 'application/javascript',
	'.mjs': 'application/javascript',
	'.xml': 'text/xml',
	'.yaml': 'text/yaml',
	'.yml': 'text/yaml',
	'.md': 'text/markdown',
	// Archives
	'.zip': 'application/zip',
	'.tar': 'application/x-tar',
	'.gz': 'application/gzip',
	// Fonts
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	// Binary
	'.wasm': 'application/wasm',
}

/** Extensions known to be binary — files that cannot be displayed as text. */
const BINARY_EXTENSIONS = new Set([
	// Images
	'.jpg',
	'.jpeg',
	'.png',
	'.gif',
	'.webp',
	'.bmp',
	'.ico',
	'.tiff',
	'.tif',
	'.avif',
	// Video
	'.mp4',
	'.webm',
	'.avi',
	'.mov',
	'.mkv',
	'.flv',
	'.wmv',
	// Audio
	'.mp3',
	'.wav',
	'.ogg',
	'.flac',
	'.aac',
	'.wma',
	'.m4a',
	// Archives
	'.zip',
	'.tar',
	'.gz',
	'.bz2',
	'.xz',
	'.7z',
	'.rar',
	'.zst',
	// Documents (binary)
	'.pdf',
	'.doc',
	'.docx',
	'.xls',
	'.xlsx',
	'.ppt',
	'.pptx',
	'.odt',
	// Fonts
	'.woff',
	'.woff2',
	'.ttf',
	'.otf',
	'.eot',
	// Compiled/binary
	'.wasm',
	'.exe',
	'.dll',
	'.so',
	'.dylib',
	'.o',
	'.a',
	'.class',
	'.pyc',
	'.pyo',
	// Database
	'.sqlite',
	'.db',
	'.sqlite3',
	// Other
	'.bin',
	'.dat',
])

// ============================================================================
// Helpers
// ============================================================================

/**
 * Determine MIME type for a file.
 * Known extensions get their specific MIME type, known binary extensions
 * get `application/octet-stream`, everything else defaults to `text/plain`
 * so that code/config files (.astro, .vue, .svelte, .go, .rs, etc.)
 * are previewable as text.
 */
function getMimeType(filePath: string): string {
	const ext = extname(filePath).toLowerCase()
	if (MIME_TYPES[ext]) return MIME_TYPES[ext]
	if (BINARY_EXTENSIONS.has(ext)) return 'application/octet-stream'
	return 'text/plain'
}

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

function preventTraversal(baseDir: string, requestedPath: string): string | null {
	const resolved = resolve(baseDir, requestedPath)
	if (!resolved.startsWith(baseDir + '/') && resolved !== baseDir) {
		return null
	}
	return resolved
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
