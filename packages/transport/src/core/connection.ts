/**
 * Connection Base Class
 *
 * Provides symmetric API for WebSocket client and server connections.
 * Simplified: no handshake, no heartbeat - just WebSocket open/close → connected/disconnected.
 * Notification-only: no request-response, no correlation.
 */

import type { IWebSocket } from '../platform/types.js'
import { WebSocketReadyState } from '../platform/types.js'
import type { Protocol, ProtocolDef, ProtocolHandlers, ProtocolNotifier } from './protocol.js'
import { MessageRouter } from './router.js'
import type { RawMessageListener } from './router.js'
import type { ConnectionState, TransportEvent, TransportEventListener } from './types.js'

/**
 * Connection configuration.
 */
export interface ConnectionConfig<TReceive extends ProtocolDef, TSend extends ProtocolDef> {
	receiveProtocol?: Protocol<TReceive>
	sendProtocol?: Protocol<TSend>
}

/**
 * What a send did.
 *
 * - `sent` — handed to an open socket.
 * - `buffered` — parked to bridge a disconnect; delivered only if the socket opens again.
 * - `dropped` — discarded, the buffer was full. Data loss.
 */
export type SendOutcome = 'sent' | 'buffered' | 'dropped'

/**
 * Abstract base class for WebSocket connections.
 * State transitions: disconnected ↔ connecting ↔ connected ↔ reconnecting
 */
export abstract class Connection<TReceive extends ProtocolDef, TSend extends ProtocolDef> {
	protected readonly config: ConnectionConfig<TReceive, TSend>
	protected readonly router: MessageRouter<TReceive, TSend>

	// State
	protected state: ConnectionState = 'disconnected'
	protected ws: IWebSocket | null = null
	protected connectionId: string
	protected eventListeners = new Set<TransportEventListener>()

	constructor(config: ConnectionConfig<TReceive, TSend>) {
		this.config = config
		this.connectionId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

		this.router = new MessageRouter(
			config.receiveProtocol ?? null,
			config.sendProtocol ?? null,
		)
		this.router.setErrorHandler((error) => this.emit('router_error', error))
	}

	// ============================================================================
	// Public API
	// ============================================================================

	getState(): ConnectionState {
		return this.state
	}

	isConnected(): boolean {
		return this.state === 'connected'
	}

	getConnectionId(): string {
		return this.connectionId
	}

	setHandlers(handlers: Partial<ProtocolHandlers<TReceive>>): void {
		this.router.setHandlers(handlers)
	}

	/**
	 * Set a raw message listener that receives every incoming message as (type, payload).
	 * When set, bypasses per-type handler dispatch.
	 */
	setRawMessageListener(listener: RawMessageListener): void {
		this.router.setRawMessageListener(listener)
	}

	get notify(): ProtocolNotifier<TSend> {
		const protocol = this.config.sendProtocol
		if (!protocol) {
			throw new Error('Cannot send notifications without a send protocol')
		}
		const notifier: Record<string, unknown> = {}
		for (const name of protocol.getNotificationNames()) {
			notifier[name as string] = (input: unknown) => this.router.notify(name, input as never)
		}
		return notifier as ProtocolNotifier<TSend>
	}

	// ============================================================================
	// Send Buffer (bridges short disconnects)
	// ============================================================================

	private sendBuffer: string[] = []
	private readonly maxBufferSize: number = 500
	private droppedSinceLastFlush = 0
	private droppedMessages = 0

	/**
	 * Send, saying which of the three things happened.
	 *
	 * `send()` collapses `buffered` and `dropped` into `false`, which is how a full
	 * buffer discarded messages with nothing upstream able to tell. Callers that
	 * care about the loss use this; the boolean stays for callers that do not.
	 */
	trySend(data: string): SendOutcome {
		if (!this.ws || this.ws.readyState !== WebSocketReadyState.OPEN) {
			return this.buffer(data)
		}
		this.flushSendBuffer()
		try {
			this.ws.send(data)
			return 'sent'
		} catch {
			return this.buffer(data)
		}
	}

	send(data: string): boolean {
		return this.trySend(data) === 'sent'
	}

	/**
	 * Buffer one message, dropping the OLDEST on overflow.
	 *
	 * These are ephemeral notifications, so a stale one is worth less than a
	 * fresh one — the previous behaviour dropped the newest and kept a queue of
	 * 500 obsolete updates. Overflow is logged once per episode rather than per
	 * message: silently vanishing notifications leave a "the UI stopped
	 * updating" report with no server-side trace at all.
	 *
	 * Overflow reports 'dropped' even though this message was kept: the connection
	 * lost a notification either way, and a caller reading that as "no loss" is
	 * back to not being told.
	 */
	private buffer(data: string): SendOutcome {
		const overflowed = this.sendBuffer.length >= this.maxBufferSize
		if (overflowed) {
			this.sendBuffer.shift()
			if (this.droppedSinceLastFlush === 0) {
				console.warn(`[transport] send buffer full (${this.maxBufferSize}), dropping oldest notifications`)
			}
			this.droppedSinceLastFlush++
			this.droppedMessages++
		}
		this.sendBuffer.push(data)
		return overflowed ? 'dropped' : 'buffered'
	}

	flushSendBuffer(): void {
		while (this.sendBuffer.length > 0) {
			if (!this.ws || this.ws.readyState !== WebSocketReadyState.OPEN) break
			const msg = this.sendBuffer.shift()!
			try {
				this.ws.send(msg)
			} catch {
				this.sendBuffer.unshift(msg)
				break
			}
		}
		if (this.sendBuffer.length === 0 && this.droppedSinceLastFlush > 0) {
			console.warn(`[transport] send buffer drained; ${this.droppedSinceLastFlush} notification(s) were dropped`)
			this.droppedSinceLastFlush = 0
		}
	}

	clearSendBuffer(): void {
		this.sendBuffer.length = 0
	}

	get bufferedMessageCount(): number {
		return this.sendBuffer.length
	}

	/** Messages this connection discarded because its send buffer was full. */
	get droppedMessageCount(): number {
		return this.droppedMessages
	}

	on(listener: TransportEventListener): () => void {
		this.eventListeners.add(listener)
		return () => this.eventListeners.delete(listener)
	}

	abstract connect(): Promise<void>
	abstract disconnect(): Promise<void>

	// ============================================================================
	// State Management
	// ============================================================================

	protected setState(newState: ConnectionState): void {
		if (newState === this.state) return
		const from = this.state
		this.state = newState
		this.emit('state_change', { from, to: newState })
		if (newState === 'connected') this.emit('connected')
		else if (newState === 'disconnected') this.emit('disconnected')
		else if (newState === 'reconnecting') this.emit('reconnecting')
	}

	// ============================================================================
	// WebSocket Setup
	// ============================================================================

	protected setupWebSocket(ws: IWebSocket): void {
		this.ws = ws
		this.router.setSender((message) => this.send(message))
		ws.onmessage = (data) => this.router.handleMessage(data, { connectionId: this.connectionId })
		ws.onerror = (error) => this.emit('error', error)
		ws.onclose = (event) => this.handleClose(event.code, event.reason)
	}

	protected handleOpen(): void {
		// Immediately connected - no handshake needed
		this.setState('connected')
	}

	protected handleClose(_code: number, _reason: string): void {
		this.cleanup()
		this.setState('disconnected')
	}

	protected handleConnectionLost(): void {
		this.cleanup()
		this.setState('disconnected')
	}

	protected cleanup(): void {
		if (this.ws) {
			this.ws.onopen = null
			this.ws.onclose = null
			this.ws.onerror = null
			this.ws.onmessage = null
		}
	}

	protected emit(event: TransportEvent, data?: unknown): void {
		for (const listener of this.eventListeners) {
			try {
				listener(event, data)
			} catch {
				// Ignore listener errors
			}
		}
	}
}
