/**
 * Connection Store
 *
 * Manages WebSocket connection state using @roj-ai/transport ClientConnection.
 * All connection state is managed within Zustand to avoid global mutable variables.
 *
 * Direct WebSocket connection to the worker using ?project=&sessionId= parameters.
 * Session subscription is determined by sessionId in the connection URL.
 *
 * This store is a dumb pipe — it forwards raw (type, payload) messages to registered
 * handlers without knowing notification types. Typing happens at the consumer level.
 */

import type { SessionId } from '@roj-ai/shared'
import { browserWebSocketFactory } from '@roj-ai/transport/browser'
import type { ProtocolDef } from '@roj-ai/transport'
import { ClientConnection, createClientConnection } from '@roj-ai/transport/client'
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

/**
 * Raw message handler — receives (type, payload) from the wire.
 * Consumers are responsible for narrowing the payload to specific notification types.
 */
export type RawMessageHandler = (type: string, payload: unknown) => void

type ConnectionInstance = ClientConnection<ProtocolDef, ProtocolDef>

/**
 * Custom URL builder function.
 * Receives (projectId, sessionId) and returns a full WebSocket URL.
 */
export type WsUrlBuilder = (projectId: string, sessionId: SessionId) => string

interface ConnectionState {
	// Connection state
	status: ConnectionStatus
	error: string | null
	agentConnected: boolean
	configuredBaseUrl: string | null
	configuredUrlBuilder: WsUrlBuilder | null
	projectId: string | null
	sessionId: SessionId | null

	// Internal: connection instance (not serializable, but zustand handles it)
	_connection: ConnectionInstance | null

	// Message handlers
	messageHandlers: Map<string, RawMessageHandler>

	// Configuration
	configureUrl: (baseUrlOrBuilder: string | WsUrlBuilder) => void

	// Actions
	connect: (projectId: string, sessionId: SessionId) => Promise<void>
	disconnect: () => void

	// Message handler registration
	addMessageHandler: (id: string, handler: RawMessageHandler) => void
	removeMessageHandler: (id: string) => void
}

/**
 * Build WebSocket URL for connection.
 * Includes both projectId and sessionId in URL parameters.
 */
function buildWsUrl(configuredBaseUrl: string | null, projectId: string, sessionId: SessionId): string {
	let baseUrl: string
	if (configuredBaseUrl) {
		baseUrl = configuredBaseUrl
	} else {
		// Default: use same host as current page (goes through Cloudflare Worker or same origin)
		baseUrl = `${window.location.protocol}//${window.location.host}`
	}

	const url = new URL('/ws/spa', baseUrl)
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	url.searchParams.set('project', projectId)
	url.searchParams.set('sessionId', sessionId)
	return url.toString()
}

/**
 * Create the connection instance with handlers.
 */
function createConnection(
	url: string,
	onStatusChange: (status: ConnectionStatus, error?: string) => void,
	onMessage: RawMessageHandler,
): ConnectionInstance {
	const conn = createClientConnection<ProtocolDef, ProtocolDef>({
		url,
		wsFactory: browserWebSocketFactory,
		reconnect: {
			baseDelayMs: 1000,
			maxDelayMs: 30000,
			maxAttempts: 10,
			jitterFactor: 0.3,
		},
	})

	// Forward all incoming messages as raw (type, payload) — no per-type knowledge
	conn.setRawMessageListener((type, payload) => {
		onMessage(type, payload)
	})

	// Set up event listeners for connection state
	conn.on((event, data) => {
		switch (event) {
			case 'connected':
				onStatusChange('connected')
				break
			case 'disconnected':
				onStatusChange('disconnected')
				break
			case 'reconnecting':
				onStatusChange('reconnecting')
				break
			case 'error':
				onStatusChange('error', data instanceof Error ? data.message : 'Connection error')
				break
		}
	})

	return conn
}

// Generation counter to ignore events from stale connections (e.g., after React double-mount)
let connectionGeneration = 0

export const useConnectionStore = create<ConnectionState>()(
	subscribeWithSelector((set, get) => ({
		status: 'disconnected',
		error: null,
		agentConnected: false,
		configuredBaseUrl: null,
		configuredUrlBuilder: null,
		projectId: null,
		sessionId: null,
		_connection: null,
		messageHandlers: new Map(),

		configureUrl: (baseUrlOrBuilder) => {
			if (typeof baseUrlOrBuilder === 'function') {
				set({ configuredUrlBuilder: baseUrlOrBuilder, configuredBaseUrl: null })
			} else {
				set({ configuredBaseUrl: baseUrlOrBuilder, configuredUrlBuilder: null })
			}
		},

		connect: async (projectId: string, sessionId: SessionId) => {
			const state = get()
			// Guard against multiple concurrent connection attempts
			if (state.status === 'connecting' || state.status === 'connected') {
				// If already connected to the same project and session, skip
				if (state.projectId === projectId && state.sessionId === sessionId) {
					return
				}
				// If connected to different project/session, disconnect first
				state.disconnect()
			}

			// Don't create new connection if one already exists for same project and session
			if (state._connection && state.projectId === projectId && state.sessionId === sessionId) {
				return
			}

			const thisGeneration = ++connectionGeneration
			set({ status: 'connecting', error: null, projectId, sessionId })

			try {
				const wsUrl = state.configuredUrlBuilder
					? state.configuredUrlBuilder(projectId, sessionId)
					: buildWsUrl(state.configuredBaseUrl, projectId, sessionId)
				const conn = createConnection(
					wsUrl,
					(status, error) => {
						// Ignore events from stale connections
						if (thisGeneration !== connectionGeneration) return
						set({
							status,
							error: error ?? null,
							// On permanent disconnect (transport gave up), clear the dead connection
							// so that connect() can create a fresh one
							...(status === 'disconnected' ? { agentConnected: false, _connection: null } : {}),
						})
					},
					(type, payload) => {
						// Ignore messages from stale connections
						if (thisGeneration !== connectionGeneration) return
						// Forward to registered handlers
						for (const handler of get().messageHandlers.values()) {
							handler(type, payload)
						}
					},
				)

				set({ _connection: conn })
				await conn.connect()
			} catch (error) {
				// Only set error if this is still the current connection attempt
				if (thisGeneration !== connectionGeneration) return
				console.error('Connection failed:', error)
				set({ status: 'error', error: error instanceof Error ? error.message : 'Connection failed', _connection: null })
				throw error
			}
		},

		disconnect: () => {
			connectionGeneration++
			const { _connection } = get()
			if (_connection) {
				_connection.disconnect()
			}
			set({ _connection: null, status: 'disconnected', agentConnected: false, projectId: null, sessionId: null })
		},

		addMessageHandler: (id, handler) => {
			const handlers = new Map(get().messageHandlers)
			handlers.set(id, handler)
			set({ messageHandlers: handlers })
		},

		removeMessageHandler: (id) => {
			const handlers = new Map(get().messageHandlers)
			handlers.delete(id)
			set({ messageHandlers: handlers })
		},
	})),
)

/**
 * Configure the WebSocket connection URL.
 * Call this before connecting to set a custom server URL.
 *
 * @param baseUrlOrBuilder - Either a base URL string (e.g., 'https://roj.example.com')
 *   or a function (projectId, sessionId) => fullWsUrl for custom URL building.
 */
export function configureConnectionUrl(baseUrlOrBuilder: string | WsUrlBuilder): void {
	useConnectionStore.getState().configureUrl(baseUrlOrBuilder)
}

/**
 * Hook for auto-connect on mount.
 * Connects directly to WebSocket with specified project and session.
 */
export function useAutoConnect(projectId: string, sessionId: SessionId): void {
	const connect = useConnectionStore((s) => s.connect)
	const connectRef = useRef(connect)
	connectRef.current = connect

	const projectIdRef = useRef(projectId)
	projectIdRef.current = projectId

	const sessionIdRef = useRef(sessionId)
	sessionIdRef.current = sessionId

	useEffect(() => {
		connectRef.current(projectIdRef.current, sessionIdRef.current).catch(console.error)
	}, [])
}
