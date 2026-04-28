/**
 * Standalone roj server — hosts the SDK agent and exposes a platform-
 * compatible REST + WebSocket surface for a single instance on localhost.
 *
 * URL shape (matches @roj-ai/client/platform):
 *   POST /api/v1/rpc                              — platform RPC (singleton)
 *   POST /api/v1/instances/{id}/rpc               — agent RPC
 *   POST /api/v1/instances/{id}/sessions/{sid}/upload — file upload (session)
 *   WS   /api/v1/instances/{id}/ws                — live events
 *   ANY  /api/v1/instances/{id}/preview/{code}/*  — dev service proxy
 *   POST /api/v1/instances/{id}/exchange          — noop (no auth locally)
 *   GET  /health                                  — health check
 */

import type { Config, LLMMiddleware, Logger, Preset, SessionId, SessionManager } from '@roj-ai/sdk'
import { bootstrap, createSystemFromServices, loadConfig, validateConfig } from '@roj-ai/sdk'
import { createApp } from '@roj-ai/sdk/transport/http/app'
import { createAgentTransport, ServerAdapter } from '@roj-ai/sdk/transport/adapter'
import { createBunPlatform } from '@roj-ai/sdk/bun-platform'
import { createBunWebSocketHandlers } from '@roj-ai/transport/bun'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createInstance, type InstanceState } from './instance.js'
import { createPlatformApi } from './platform-api.js'
import { proxyPreview } from './preview-proxy.js'

export interface StartStandaloneOptions {
	presets: Preset[]
	config?: Partial<Config>
	instanceId?: string
	instanceName?: string
	llmMiddleware?: LLMMiddleware[]
	onShutdown?: () => Promise<void> | void
	onBeforeStart?: (ctx: { config: Config; logger: Logger }) => void | Promise<void>
}

export interface StandaloneHandle {
	config: Config
	logger: Logger
	instance: InstanceState
	/** Resolved listen port (useful when config.port was 0 — OS-assigned). */
	port: number
	/** Underlying session manager. Exposed for tests that need to assert on session state. */
	sessionManager: SessionManager
	shutdown(): Promise<void>
}

export async function startStandaloneServer(options: StartStandaloneOptions): Promise<StandaloneHandle> {
	const envConfig = loadConfig()
	const config: Config = options.config ? { ...envConfig, ...options.config } : envConfig

	const errors = validateConfig(config)
	if (errors.length > 0) {
		throw new Error(`Configuration errors:\n${errors.map(e => `  - ${e}`).join('\n')}`)
	}

	const presets = options.llmMiddleware?.length
		? options.presets.map(p => ({
			...p,
			llmMiddleware: [...options.llmMiddleware!, ...(p.llmMiddleware ?? [])],
		}))
		: options.presets

	const services = bootstrap(config, { presets }, createBunPlatform())
	const { logger } = services

	const instance = createInstance({
		id: options.instanceId,
		name: options.instanceName,
		presetIds: presets.map(p => p.id),
	})

	if (options.onBeforeStart) {
		await options.onBeforeStart({ config, logger })
	}

	const transport = createAgentTransport({ mode: 'standalone', logger })
	const serverAdapter = transport instanceof ServerAdapter ? transport : null

	const system = createSystemFromServices(services, {
		onUserOutput: (message) => transport.broadcast(message),
	})
	const sessionManager = system.sessionManager

	const agentApp = createApp({
		...services,
		sessionRuntime: sessionManager,
	})

	const platformApp = createPlatformApi({ instance, sessionManager, logger })

	const outerApp = new Hono()
	// Reflect the request origin and allow credentials — the SPA uses
	// `credentials: 'include'` on its RPC fetches, which requires a specific
	// origin header (not `*`) plus `Access-Control-Allow-Credentials: true`.
	outerApp.use('*', cors({ origin: (origin) => origin ?? '*', credentials: true }))

	outerApp.get('/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }))
	outerApp.route('/api/v1', platformApp)

	// Path-based preview proxy (must come BEFORE the catch-all instance route)
	outerApp.all('/api/v1/instances/:id/preview/*', (c) => {
		const id = c.req.param('id')
		const prefix = `/api/v1/instances/${id}/preview/`
		return proxyPreview(c.req.raw, prefix, sessionManager, logger)
	})

	// Noop auth-exchange (platform has real cookies; standalone is open)
	outerApp.post('/api/v1/instances/:id/exchange', (c) => c.json({ ok: true }))

	// Instance-scoped agent routes — strip the instance prefix and delegate to createApp
	outerApp.all('/api/v1/instances/:id/*', async (c) => {
		const id = c.req.param('id')
		const prefix = `/api/v1/instances/${id}`
		const url = new URL(c.req.url)
		const innerPath = url.pathname.slice(prefix.length) || '/'
		const innerUrl = `${url.origin}${innerPath}${url.search}`
		return agentApp.fetch(new Request(innerUrl, c.req.raw))
	})

	const server = startBunServer(config, outerApp, serverAdapter)

	try {
		await sessionManager.loadAllSessions()
	} catch (err) {
		logger.error('Failed to load persisted sessions', err instanceof Error ? err : new Error(String(err)))
	}

	try {
		await transport.start()
	} catch (err) {
		logger.error('Transport start failed', err instanceof Error ? err : new Error(String(err)))
	}

	logger.info('Standalone server started', {
		host: config.host,
		port: config.port,
		instanceId: instance.id,
		url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
	})

	const shutdown = async () => {
		logger.info('Shutting down standalone server...')
		if (options.onShutdown) {
			await options.onShutdown()
		}
		await sessionManager.shutdown()
		await transport.stop()
		server.stop()
	}

	process.on('SIGINT', () => {
		void shutdown().then(() => process.exit(0))
	})
	process.on('SIGTERM', () => {
		void shutdown().then(() => process.exit(0))
	})

	return { config, logger, instance, port: server.port ?? config.port, sessionManager, shutdown }
}

interface WSData {
	clientId: string
	sessionId: string | null
	subscribedSessions: Set<SessionId>
}

function startBunServer(
	config: Config,
	app: Hono,
	serverAdapter: ServerAdapter | null,
) {
	const wsHandlers = serverAdapter
		? createBunWebSocketHandlers<WSData>({
			onOpen: (ws) => serverAdapter.handleOpen(ws, ws.data.sessionId ?? undefined),
			onClose: (ws, code, reason) => serverAdapter.handleClose(ws, code, reason),
			onMessage: (ws, message) => serverAdapter.handleMessage(ws, message),
			onError: (ws, error) => serverAdapter.handleError(ws, error),
			getData: (ws) => ws.data,
		})
		: null

	return Bun.serve<WSData>({
		port: config.port,
		hostname: config.host,
		fetch(req, server) {
			const url = new URL(req.url)
			const wsMatch = url.pathname.match(/^\/api\/v1\/instances\/[^/]+\/ws$/)
			if (wsMatch && serverAdapter) {
				const sessionId = url.searchParams.get('sessionId')
				const upgraded = server.upgrade(req, {
					data: {
						clientId: crypto.randomUUID(),
						sessionId,
						subscribedSessions: new Set<SessionId>(),
					} satisfies WSData,
				})
				return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
			}
			return app.fetch(req)
		},
		websocket: wsHandlers ?? { open() {}, close() {}, message() {} },
	})
}

