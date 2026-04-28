/**
 * Preview proxy — forwards requests from
 *   /api/v1/instances/{id}/preview/{code}/{...path}
 * to the localhost port of a running dev service.
 *
 * The {code} segment is treated as a service type (e.g. "dev"). The first
 * running session that has a service of that type wins. For single-session
 * flows this is deterministic; for multi-session flows the caller should
 * pick a more specific code if needed.
 */

import type { Logger, SessionManager } from '@roj-ai/sdk'
import { selectPluginState } from '@roj-ai/sdk'

interface ServiceEntry {
	port?: number
	status?: string
}

export async function resolveServicePort(
	sessionManager: SessionManager,
	serviceType: string,
): Promise<number | null> {
	const stats = await sessionManager.getStats()
	for (const { id } of stats.sessions) {
		const result = await sessionManager.getSession(id)
		if (!result.ok) continue
		const services = selectPluginState<Map<string, ServiceEntry>>(result.value.state, 'services')
		const entry = services?.get(serviceType)
		// Accept any non-failed status as long as a port is assigned. The
		// services plugin emits `ready` (not `running`); the state projection
		// can also briefly lag the WS `serviceStatus` broadcast that clients
		// use to decide when to render the preview iframe.
		if (entry?.port && entry.status !== 'failed' && entry.status !== 'stopped') {
			return entry.port
		}
	}
	return null
}

export async function proxyPreview(
	req: Request,
	prefix: string,
	sessionManager: SessionManager,
	logger: Logger,
): Promise<Response> {
	const url = new URL(req.url)
	const rest = url.pathname.slice(prefix.length)
	const [code, ...restParts] = rest.split('/').filter(Boolean)

	if (!code) {
		return new Response('preview code required', { status: 404 })
	}

	const port = await resolveServicePort(sessionManager, code)
	if (!port) {
		return new Response(`No service running for code "${code}"`, { status: 503 })
	}

	const targetPath = '/' + restParts.join('/')
	const targetUrl = `http://127.0.0.1:${port}${targetPath}${url.search}`

	const headers = new Headers(req.headers)
	headers.delete('host')

	try {
		const upstream = await fetch(targetUrl, {
			method: req.method,
			headers,
			body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
			redirect: 'manual',
		})
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: upstream.headers,
		})
	} catch (err) {
		logger.warn('Preview proxy upstream failed', {
			code,
			port,
			error: err instanceof Error ? err.message : String(err),
		})
		return new Response('Preview upstream unreachable', { status: 502 })
	}
}
