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

import type { Logger, RuntimeLeaseRelease, SessionState } from '@roj-ai/sdk'
import { selectPluginState } from '@roj-ai/sdk'

interface ServiceEntry {
	port?: number
	status?: string
}

/** The slice of a session runtime this proxy needs — `Session` satisfies it. */
export interface PreviewSession {
	readonly state: SessionState
	tryAcquireRuntimeLease(reason: string): RuntimeLeaseRelease | null
}

/** The slice of the manager this proxy needs — `SessionManager` satisfies it. */
export interface PreviewSessionSource {
	listResidentSessions(): Promise<PreviewSession[]>
}

export interface PreviewTarget {
	port: number
	/** Runtime lease held for this request — release it once the response is done. */
	release: RuntimeLeaseRelease
}

/**
 * Find a resident session running `serviceType` and lease its runtime.
 *
 * Resident runtimes only: a session is not kept resident by a healthy service any
 * more, and loading one here would let a proxied asset GET resurrect an evicted
 * session and reset every runtime's idle clock.
 *
 * The lease is what keeps the service alive for the request. Without it, idle
 * eviction stops the dev server mid-response — an HMR or SSE stream outlives the
 * idle window on its own, since it never produces a new request to refresh it.
 */
export async function acquirePreviewTarget(
	sessions: PreviewSessionSource,
	serviceType: string,
): Promise<PreviewTarget | null> {
	for (const session of await sessions.listResidentSessions()) {
		const services = selectPluginState<Map<string, ServiceEntry>>(session.state, 'services')
		const entry = services?.get(serviceType)
		// Accept any non-failed status as long as a port is assigned. The
		// services plugin emits `ready` (not `running`); the state projection
		// can also briefly lag the WS `serviceStatus` broadcast that clients
		// use to decide when to render the preview iframe.
		if (!entry?.port || entry.status === 'failed' || entry.status === 'stopped') continue
		// Losing the race with an eviction that already started is normal — skip
		// that session rather than serving a port that is about to close.
		const release = session.tryAcquireRuntimeLease(`preview:${serviceType}`)
		if (release) return { port: entry.port, release }
	}
	return null
}

export async function proxyPreview(
	req: Request,
	prefix: string,
	sessions: PreviewSessionSource,
	logger: Logger,
): Promise<Response> {
	const url = new URL(req.url)
	const rest = url.pathname.slice(prefix.length)
	const [code, ...restParts] = rest.split('/').filter(Boolean)

	if (!code) {
		return new Response('preview code required', { status: 404 })
	}

	const target = await acquirePreviewTarget(sessions, code)
	if (!target) {
		return new Response(`No service running for code "${code}"`, { status: 503 })
	}

	let released = false
	const release = () => {
		if (released) return
		released = true
		target.release()
	}
	// A client that walks away mid-stream never reaches the flush below.
	req.signal.addEventListener('abort', release, { once: true })

	const targetPath = '/' + restParts.join('/')
	const targetUrl = `http://127.0.0.1:${target.port}${targetPath}${url.search}`

	const headers = new Headers(req.headers)
	headers.delete('host')

	try {
		const upstream = await fetch(targetUrl, {
			method: req.method,
			headers,
			body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
			redirect: 'manual',
		})
		if (!upstream.body) {
			release()
			return new Response(null, {
				status: upstream.status,
				statusText: upstream.statusText,
				headers: upstream.headers,
			})
		}
		// Pump manually so the lease is released on every ending the body can have:
		// last chunk, upstream failure, or a consumer that walks away.
		const reader = upstream.body.getReader()
		const tracked = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read()
					if (done) {
						controller.close()
						release()
						return
					}
					controller.enqueue(value)
				} catch (error) {
					controller.error(error)
					release()
				}
			},
			cancel(reason) {
				release()
				return reader.cancel(reason)
			},
		})
		return new Response(tracked, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: upstream.headers,
		})
	} catch (err) {
		release()
		logger.warn('Preview proxy upstream failed', {
			code,
			port: target.port,
			error: err instanceof Error ? err.message : String(err),
		})
		return new Response('Preview upstream unreachable', { status: 502 })
	}
}
