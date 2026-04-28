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
import type { IAgentTransport, PluginNotification } from './types.js'

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

	broadcast(notification: PluginNotification): void {
		// Send as wire message — protocol validation happens at the DO side
		this.connection.send(JSON.stringify({
			type: notification.type,
			payload: notification.payload,
			ts: Date.now(),
		}))
	}
}
