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
import { type IAgentTransport, type NotificationDelivery, type PluginNotification, undelivered } from './types.js'

/**
 * Frame size past which a host is likely to refuse the send.
 *
 * The SDK cannot know its host's ceiling: workerd closes the *receiving* socket
 * with 1009 at 32 MiB, Bun's `maxPayloadLength` defaults to 16 MiB. Warn at the
 * lower of the two and send anyway — guessing a limit and dropping under it would
 * lose notifications a host would have carried.
 */
const LARGE_FRAME_BYTES = 16 * 1024 * 1024

/** Close codes a peer uses for "we are done here"; anything else is worth a line in the log. */
const CLEAN_CLOSE_CODES = new Set([1000, 1001, 1005])

/** The peer refused a frame for its size — see LARGE_FRAME_BYTES. */
const CLOSE_MESSAGE_TOO_BIG = 1009

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

	broadcast(notification: PluginNotification): NotificationDelivery {
		// Extract sessionId from payload for routing to the correct session's subscribers
		const payload = notification.payload
		if (typeof payload !== 'object' || payload === null || !('sessionId' in payload)) {
			this.logger?.warn('Notification dropped: no sessionId in payload', { type: notification.type })
			return undelivered(0)
		}
		const sessionId = String(payload.sessionId)
		const wireMessage = JSON.stringify({ type: notification.type, payload: notification.payload, ts: Date.now() })
		const { subscribers, delivered, buffered, dropped } = this.connectionManager.broadcast(sessionId, wireMessage)
		const delivery: NotificationDelivery = { bytes: wireMessage.length, peers: subscribers, delivered, buffered, dropped }

		if (delivery.bytes > LARGE_FRAME_BYTES) {
			// A frame this size is what a 1009 close a moment later will have been about.
			this.logger?.warn('Notification frame is larger than a host may accept', {
				type: notification.type,
				sessionId,
				bytes: delivery.bytes,
				limitBytes: LARGE_FRAME_BYTES,
			})
		}
		if (dropped > 0) {
			this.logger?.warn('Notification discarded: send buffer full', { type: notification.type, sessionId, bytes: delivery.bytes, subscribers, delivered, buffered, dropped })
		} else if (buffered > 0) {
			this.logger?.debug('Notification buffered: socket not open', { type: notification.type, sessionId, subscribers, delivered, buffered })
		}

		return delivery
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
		if (!connectionId) return

		// Read before remove(): whatever is still buffered dies with the connection,
		// and a server connection never reconnects to flush it.
		const connection = this.connectionManager.get(connectionId)
		const lost = connection?.bufferedMessageCount ?? 0
		const dropped = connection?.droppedMessageCount ?? 0

		this.connectionManager.remove(connectionId)
		this.wsToConnectionId.delete(ws)

		const context = { connectionId, code, reason, undeliveredNotifications: lost, droppedNotifications: dropped }
		if (code === CLOSE_MESSAGE_TOO_BIG) {
			this.logger?.warn('Client closed the connection: frame too large', context)
		} else if (!CLEAN_CLOSE_CODES.has(code) || lost > 0 || dropped > 0) {
			this.logger?.warn('Client disconnected with notifications outstanding', context)
		} else {
			this.logger?.debug('Client disconnected', context)
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
