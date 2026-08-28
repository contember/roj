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
import { encodeProbe, isAckFrame } from './heartbeat.js'
import type { IAgentTransport, PluginNotification } from './types.js'

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000

/** Unanswered probes tolerated before the link counts as dead. */
const MAX_MISSED_BEATS = 3

export interface ClientAdapterConfig {
	url: string
	wsFactory: IWebSocketFactory
	reconnect?: Partial<ReconnectOptions>
	logger?: Logger
	/** Liveness probe cadence. Defaults to 10s. */
	heartbeatIntervalMs?: number
}

export class ClientAdapter implements IAgentTransport {
	private readonly config: ClientAdapterConfig
	private readonly connection: ClientConnection<ProtocolDef, ProtocolDef>
	private readonly logger?: Logger
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null
	private missedBeats = 0
	private ackObserved = false

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
		this.connection.setRawMessageListener((type, payload) => {
			if (!isAckFrame(type, payload)) return
			this.ackObserved = true
			this.missedBeats = 0
		})
		// Answering is a property of the peer, not of this adapter: a reconnect can land
		// on a host that does not, so every connection has to earn the arming again.
		this.connection.on((event) => {
			if (event !== 'connected') return
			this.ackObserved = false
			this.missedBeats = 0
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
		this.missedBeats = 0
		this.heartbeatTimer = setInterval(
			() => this.beat(),
			this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
		)
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = null
		}
	}

	private beat(): void {
		if (!this.connection.isConnected()) {
			this.missedBeats = 0
			return
		}

		// Armed only once this peer has answered, so a host that never acks reads as
		// "does not implement the probe" rather than as a dead link.
		if (this.ackObserved && this.missedBeats >= MAX_MISSED_BEATS) {
			this.logger?.warn('Heartbeat unanswered, reconnecting', { missedBeats: this.missedBeats })
			void this.reconnect()
			return
		}

		this.missedBeats++
		this.connection.send(encodeProbe())
	}

	private async reconnect(): Promise<void> {
		this.missedBeats = 0
		try {
			await this.connection.disconnect()
			// stop() may have run while the socket was tearing down — do not revive it.
			if (this.heartbeatTimer === null) return
			await this.connection.connect()
		} catch (error) {
			this.logger?.error(
				'Reconnect after missed heartbeats failed',
				error instanceof Error ? error : new Error(String(error)),
			)
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
