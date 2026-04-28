/**
 * High-level API for starting the Agent Server.
 *
 * Handles: config loading, bootstrap, transport, session manager,
 * HTTP app, Bun.serve, session loading, and shutdown.
 */

import type { Config, LLMMiddleware, Logger, Preset, SessionId } from '@roj-ai/sdk'
import { bootstrap, createSystemFromServices, loadConfig, validateConfig } from '@roj-ai/sdk'
import { type AppEnv, createApp } from '@roj-ai/sdk/transport/http/app'
import { createAgentTransport, type IAgentTransport, ServerAdapter } from '@roj-ai/sdk/transport/adapter'
import { bunWebSocketFactory, createBunWebSocketHandlers } from '@roj-ai/transport/bun'
import type { Hono } from 'hono'
import { createBunPlatform } from '@roj-ai/sdk/bun-platform'

// ============================================================================
// Public types
// ============================================================================

export interface StartServerOptions {
	presets: Preset[]
	config?: Partial<Config>
	/** Global LLM middleware applied to all presets (prepended before preset-level middleware) */
	llmMiddleware?: LLMMiddleware[]
	onShutdown?: () => Promise<void> | void
	onBeforeStart?: (ctx: { config: Config; logger: Logger }) => void | Promise<void>
}

export interface ServerHandle {
	config: Config
	logger: Logger
	shutdown(): Promise<void>
}

// ============================================================================
// startServer
// ============================================================================

export async function startServer(options: StartServerOptions): Promise<ServerHandle> {
	// Load config from env and merge overrides
	const envConfig = loadConfig()
	const config: Config = options.config ? { ...envConfig, ...options.config } : envConfig

	const errors = validateConfig(config)
	if (errors.length > 0) {
		throw new Error(`Configuration errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
	}

	// Apply global LLM middleware to all presets (prepended before preset-level middleware)
	const presets = options.llmMiddleware?.length
		? options.presets.map(p => ({
			...p,
			llmMiddleware: [...options.llmMiddleware!, ...(p.llmMiddleware ?? [])],
		}))
		: options.presets

	const services = bootstrap(config, { presets }, createBunPlatform())
	const { logger } = services

	if (options.onBeforeStart) {
		await options.onBeforeStart({ config, logger })
	}

	// Auto-detect mode from config
	const isWorkerMode = !!(config.workerUrl && config.agentToken)
	const transport = createTransport(config, logger, isWorkerMode)

	const system = createSystemFromServices(services, {
		onUserOutput: (message) => transport.broadcast(message),
	})
	const sessionManager = system.sessionManager

	const app = createApp({
		...services,
		sessionRuntime: sessionManager,
		agentToken: config.agentToken,
	})

	const server = startBunServer(config, app, transport)

	// Load persisted sessions after HTTP server is up (health checks pass during loading)
	try {
		await sessionManager.loadAllSessions()
	} catch (error) {
		logger.error('Failed to load persisted sessions', error instanceof Error ? error : new Error(String(error)))
	}

	try {
		await transport.start()
	} catch (error) {
		logger.error('Transport connection failed (will retry via reconnect)', error instanceof Error ? error : new Error(String(error)))
	}

	logger.info('Agent server started', {
		host: config.host,
		port: config.port,
		persistence: config.persistence,
		mode: isWorkerMode ? 'worker' : 'standalone',
	})

	const shutdown = async () => {
		logger.info('Shutting down...')
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

	return { config, logger, shutdown }
}

// ============================================================================
// Internal helpers
// ============================================================================

function createTransport(config: Config, logger: Logger, isWorkerMode: boolean): IAgentTransport {
	if (isWorkerMode) {
		const sandboxId = process.env.SANDBOX_ID
		if (!sandboxId) {
			throw new Error('SANDBOX_ID is required in worker mode')
		}

		const url = new URL('/ws/agent', config.workerUrl!)
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
		url.searchParams.set('sandboxId', sandboxId)
		url.searchParams.set('token', config.agentToken!)

		return createAgentTransport({
			mode: 'worker',
			url: url.toString(),
			wsFactory: bunWebSocketFactory,
			reconnect: {
				baseDelayMs: config.wsReconnectBaseDelayMs ?? 1000,
				maxDelayMs: config.wsReconnectMaxDelayMs ?? 30000,
				maxAttempts: Infinity,
				jitterFactor: 0.3,
			},
			logger,
		})
	}

	return createAgentTransport({ mode: 'standalone', logger })
}

interface WSData {
	clientId: string
	clientType: 'spa' | 'agent'
	sessionId: string | null
	subscribedSessions: Set<SessionId>
}

function createWSData(sessionId: string | null = null): WSData {
	return {
		clientId: crypto.randomUUID(),
		clientType: 'spa',
		sessionId,
		subscribedSessions: new Set<SessionId>(),
	}
}

function startBunServer(config: Config, app: Hono<AppEnv>, transport: IAgentTransport) {
	const serverAdapter = transport instanceof ServerAdapter ? transport : null

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
			if (url.pathname === '/ws/spa' && serverAdapter) {
				const sessionId = url.searchParams.get('sessionId')
				const upgraded = server.upgrade(req, { data: createWSData(sessionId) })
				return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
			}
			return app.fetch(req)
		},
		websocket: wsHandlers ?? { open() {}, close() {}, message() {} },
	})
}
