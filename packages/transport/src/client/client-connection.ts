/**
 * Client Connection
 *
 * WebSocket client with automatic reconnection.
 * Simplified: no handshake - connected immediately when WebSocket opens.
 */

import { Connection } from '../core/connection.js'
import type { ConnectionConfig } from '../core/connection.js'
import type { ProtocolDef } from '../core/protocol.js'
import type { ReconnectOptions } from '../core/types.js'
import { DEFAULT_RECONNECT_OPTIONS } from '../core/types.js'
import type { IWebSocketFactory } from '../platform/types.js'
import { WebSocketReadyState } from '../platform/types.js'

/**
 * Client connection configuration.
 */
export interface ClientConnectionConfig<TReceive extends ProtocolDef, TSend extends ProtocolDef> extends ConnectionConfig<TReceive, TSend> {
	url: string
	wsFactory: IWebSocketFactory
	reconnect?: Partial<ReconnectOptions>
}

/**
 * WebSocket client with automatic reconnection and exponential backoff.
 */
export class ClientConnection<TReceive extends ProtocolDef, TSend extends ProtocolDef> extends Connection<TReceive, TSend> {
	private readonly url: string
	private readonly wsFactory: IWebSocketFactory

	// Reconnection
	private readonly reconnectOptions: ReconnectOptions | null
	private reconnectAttempts = 0
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private reconnectStopped = false

	// Connect promise
	private connectPromise: Promise<void> | null = null
	private connectResolve: (() => void) | null = null
	private connectReject: ((error: Error) => void) | null = null
	private intentionalDisconnect = false

	constructor(config: ClientConnectionConfig<TReceive, TSend>) {
		super(config)
		this.url = config.url
		this.wsFactory = config.wsFactory
		this.reconnectOptions = config.reconnect
			? { ...DEFAULT_RECONNECT_OPTIONS, ...config.reconnect }
			: null
	}

	async connect(): Promise<void> {
		if (this.isConnected()) return
		if (this.connectPromise) return this.connectPromise

		this.intentionalDisconnect = false
		this.reconnectStopped = false

		this.connectPromise = new Promise<void>((resolve, reject) => {
			this.connectResolve = resolve
			this.connectReject = reject
			this.doConnect()
		})

		return this.connectPromise
	}

	async disconnect(): Promise<void> {
		this.intentionalDisconnect = true
		this.stopReconnect()
		this.cleanup()

		if (this.ws && this.ws.readyState !== WebSocketReadyState.CLOSED) {
			this.ws.close(1000, 'Client disconnect')
		}

		this.ws = null
		this.setState('disconnected')

		if (this.connectReject) {
			this.connectReject(new Error('Disconnected'))
			this.clearConnectPromise()
		}
	}

	getReconnectAttempts(): number {
		return this.reconnectAttempts
	}

	hasReconnect(): boolean {
		return this.reconnectOptions !== null
	}

	// Override to resolve connect promise and reset reconnect
	protected override handleOpen(): void {
		const wasReconnecting = this.reconnectAttempts > 0
		super.handleOpen()
		this.reconnectAttempts = 0

		// Flush any messages buffered during disconnect
		this.flushSendBuffer()

		if (this.connectResolve) {
			this.connectResolve()
			this.clearConnectPromise()
		}

		// Emit reconnected event so application can restore subscriptions
		if (wasReconnecting) {
			this.emit('reconnected')
		}
	}

	protected override handleClose(code: number, reason: string): void {
		this.cleanup()

		if (this.intentionalDisconnect) {
			this.setState('disconnected')
			return
		}

		if (this.connectReject) {
			this.connectReject(new Error(`Connection closed: ${code} ${reason}`))
			this.clearConnectPromise()
		}

		this.handleConnectionLost()
	}

	protected override handleConnectionLost(): void {
		this.cleanup()

		if (this.intentionalDisconnect) {
			this.setState('disconnected')
			return
		}

		if (!this.reconnectOptions || this.reconnectStopped) {
			this.setState('disconnected')
			return
		}

		if (this.reconnectAttempts >= this.reconnectOptions.maxAttempts) {
			this.emit('error', new Error('Max reconnection attempts reached'))
			this.setState('disconnected')
			return
		}

		this.setState('reconnecting')
		const delay = this.calculateReconnectDelay()
		this.reconnectAttempts++

		this.emit('reconnecting', { delay, attempt: this.reconnectAttempts })

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			this.setState('connecting')
			this.doConnect()
		}, delay)
	}

	private doConnect(): void {
		this.setState('connecting')

		try {
			const ws = this.wsFactory.create(this.url)
			this.setupWebSocket(ws)
			ws.onopen = () => this.handleOpen()
		} catch (error) {
			if (this.connectReject) {
				this.connectReject(error instanceof Error ? error : new Error('Connection failed'))
				this.clearConnectPromise()
			}
			this.handleConnectionLost()
		}
	}

	private calculateReconnectDelay(): number {
		if (!this.reconnectOptions) return 0
		const { baseDelayMs, maxDelayMs, jitterFactor } = this.reconnectOptions
		const exponential = baseDelayMs * Math.pow(2, this.reconnectAttempts)
		const capped = Math.min(exponential, maxDelayMs)
		const jitter = capped * jitterFactor * Math.random()
		return Math.floor(capped + jitter)
	}

	private stopReconnect(): void {
		this.reconnectStopped = true
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
	}

	private clearConnectPromise(): void {
		this.connectPromise = null
		this.connectResolve = null
		this.connectReject = null
	}
}

export function createClientConnection<TReceive extends ProtocolDef, TSend extends ProtocolDef>(
	config: ClientConnectionConfig<TReceive, TSend>,
): ClientConnection<TReceive, TSend> {
	return new ClientConnection(config)
}
