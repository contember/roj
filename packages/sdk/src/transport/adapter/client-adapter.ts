/**
 * Client Adapter
 *
 * Worker mode - agent connects to DO as WebSocket client.
 * Simplified for broadcast-only communication (agent -> DO -> SPA).
 * User messages and answers are handled via REST API.
 *
 * Authentication: Token is passed in the WebSocket URL as query parameter
 * and Authorization header (handled by DO before upgrade).
 */

import type { IWebSocketFactory, ProtocolDef, ReconnectOptions } from '@roj-ai/transport'
import { ClientConnection } from '@roj-ai/transport/client'
import type { Logger } from '../../lib/logger/logger.js'
import type { IAgentTransport, NotificationDelivery, PluginNotification } from './types.js'

export interface ClientAdapterConfig {
	url: string
	wsFactory: IWebSocketFactory
	reconnect?: Partial<ReconnectOptions>
	logger?: Logger
}

export class ClientAdapter implements IAgentTransport {
	private readonly config: ClientAdapterConfig
	private readonly connection: ClientConnection<ProtocolDef, ProtocolDef>
	private readonly logger?: Logger
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null

	constructor(config: ClientAdapterConfig) {
		this.config = config
		this.logger = config.logger?.child({ component: 'ClientAdapter' })
		this.connection = new ClientConnection({
			url: config.url,
			wsFactory: config.wsFactory,
			reconnect: config.reconnect ?? {
				baseDelayMs: 1000,
				maxDelayMs: 30000,
				maxAttempts: Infinity,
				jitterFactor: 0.3,
			},
		})
	}

	async start(): Promise<void> {
		this.logger?.info('Connecting to DO', { url: this.config.url })
		await this.connection.connect()
		this.logger?.info('Connected to DO')
		this.startHeartbeat()
	}

	async stop(): Promise<void> {
		this.stopHeartbeat()
		this.logger?.info('Disconnecting from DO')
		await this.connection.disconnect()
		this.logger?.info('Disconnected from DO')
	}

	private startHeartbeat(): void {
		this.stopHeartbeat()
		this.heartbeatTimer = setInterval(() => {
			this.connection.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() }))
		}, 10_000)
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = null
		}
	}

	broadcast(notification: PluginNotification): NotificationDelivery {
		// Send as wire message — protocol validation happens at the DO side
		const wireMessage = JSON.stringify({
			type: notification.type,
			payload: notification.payload,
			ts: Date.now(),
		})
		// One peer: the DO, which fans out from there.
		const delivery: NotificationDelivery = { bytes: wireMessage.length, peers: 1, delivered: 0, buffered: 0, dropped: 0 }

		switch (this.connection.trySend(wireMessage)) {
			case 'sent':
				delivery.delivered = 1
				break
			case 'buffered':
				// The client reconnects, so a buffered frame still has a chance.
				delivery.buffered = 1
				break
			case 'dropped':
				delivery.dropped = 1
				this.logger?.warn('Notification discarded: send buffer full', { type: notification.type, bytes: delivery.bytes })
				break
		}

		return delivery
	}
}
