/**
 * Server Adapter
 *
 * Standalone mode - agent is the WebSocket server.
 * Simplified for broadcast-only communication (agent -> SPA).
 * User messages and answers are handled via REST API.
 */

import type { IServerWebSocket, ProtocolDef } from '@roj-ai/transport'
import { ConnectionManager, ServerConnection } from '@roj-ai/transport/server'
import type { Logger } from '../../lib/logger/logger.js'
import type { IAgentTransport, PluginNotification } from './types.js'

export interface ServerAdapterConfig {
	logger?: Logger
}

export class ServerAdapter implements IAgentTransport {
	private readonly connectionManager: ConnectionManager
	private readonly logger?: Logger
	private readonly wsToConnectionId = new WeakMap<IServerWebSocket, string>()

	constructor(config: ServerAdapterConfig = {}) {
		this.logger = config.logger?.child({ component: 'ServerAdapter' })
		this.connectionManager = new ConnectionManager()
	}

	async start(): Promise<void> {
		this.logger?.info('Server adapter started')
	}

	async stop(): Promise<void> {
		this.connectionManager.clear()
		this.logger?.info('Server adapter stopped')
	}

	broadcast(notification: PluginNotification): void {
		// Extract sessionId from payload for routing to the correct session's subscribers
		const payload = notification.payload
		if (typeof payload !== 'object' || payload === null || !('sessionId' in payload)) {
			this.logger?.warn('Notification dropped: no sessionId in payload', { type: notification.type })
			return
		}
		const sessionId = String(payload.sessionId)
		const wireMessage = JSON.stringify({ type: notification.type, payload: notification.payload, ts: Date.now() })
		this.connectionManager.broadcast(sessionId, wireMessage)
	}

	// ============================================================================
	// WebSocket Handler Integration (called from Bun server)
	// ============================================================================

	handleOpen(ws: IServerWebSocket, sessionId?: string): void {
		const connection = new ServerConnection<ProtocolDef, ProtocolDef>({})

		// No handlers needed - SPA doesn't send anything via WebSocket
		// Session subscription is determined by sessionId passed at connection time

		connection.attach(ws)
		this.connectionManager.add(connection)
		this.wsToConnectionId.set(ws, connection.getConnectionId())

		// If sessionId provided, auto-subscribe
		if (sessionId) {
			this.connectionManager.subscribe(connection.getConnectionId(), sessionId)
			this.logger?.debug('Client connected and subscribed', { connectionId: connection.getConnectionId(), sessionId })
		} else {
			this.logger?.debug('Client connected', { connectionId: connection.getConnectionId() })
		}
	}

	handleClose(ws: IServerWebSocket, code: number, reason: string): void {
		const connectionId = this.wsToConnectionId.get(ws)
		if (connectionId) {
			this.connectionManager.remove(connectionId)
			this.wsToConnectionId.delete(ws)
			this.logger?.debug('Client disconnected', { connectionId, code, reason })
		}
	}

	handleMessage(ws: IServerWebSocket, message: string): void {
		// Forward message to the connection's onmessage handler
		ws.onmessage?.(message)
	}

	handleError(_ws: IServerWebSocket, error: Error): void {
		this.logger?.error('WebSocket error', error)
	}

	getConnectionManager(): ConnectionManager {
		return this.connectionManager
	}
}
