/**
 * Bun WebSocket Adapters
 *
 * Provides both client and server WebSocket adapters for Bun runtime.
 */

import type { ICloseEvent, IServerWebSocket, IWebSocket, IWebSocketFactory } from './types.js'
import { WebSocketReadyState } from './types.js'

// Type for Bun's native WebSocket
type BunWebSocket = WebSocket

/**
 * Bun WebSocket client adapter.
 * Wraps Bun's WebSocket client to conform to IWebSocket interface.
 */
class BunWebSocketClientAdapter implements IWebSocket {
	private readonly ws: BunWebSocket

	onopen: (() => void) | null = null
	onclose: ((event: ICloseEvent) => void) | null = null
	onerror: ((error: Error) => void) | null = null
	onmessage: ((data: string) => void) | null = null

	constructor(url: string) {
		this.ws = new WebSocket(url)

		this.ws.onopen = () => {
			this.onopen?.()
		}

		this.ws.onclose = (event) => {
			this.onclose?.({
				code: event.code,
				reason: event.reason,
			})
		}

		this.ws.onerror = () => {
			this.onerror?.(new Error('WebSocket error'))
		}

		this.ws.onmessage = (event) => {
			if (typeof event.data === 'string') {
				this.onmessage?.(event.data)
			}
		}
	}

	get readyState(): WebSocketReadyState {
		return this.ws.readyState as WebSocketReadyState
	}

	send(data: string): void {
		if (this.ws.readyState === WebSocketReadyState.OPEN) {
			this.ws.send(data)
		}
	}

	close(code?: number, reason?: string): void {
		this.ws.close(code, reason)
	}
}

/**
 * Bun WebSocket client factory.
 */
export const bunWebSocketFactory: IWebSocketFactory = {
	create(url: string): IWebSocket {
		return new BunWebSocketClientAdapter(url)
	},
}

/**
 * Server WebSocket data interface.
 */
export interface ServerWebSocketData<T = unknown> {
	/** User-attached data */
	userData: T
	/** Topics this connection is subscribed to */
	topics: Set<string>
}

// Using 'any' here because Bun's ServerWebSocket has complex generics
// that would require importing Bun types directly
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunServerWebSocket = any

/**
 * Bun server WebSocket adapter.
 * Wraps Bun's ServerWebSocket to conform to IServerWebSocket interface.
 */
export class BunServerWebSocketAdapter<T = unknown> implements IServerWebSocket<T> {
	private readonly ws: BunServerWebSocket
	private wsData: ServerWebSocketData<T>

	onopen: (() => void) | null = null
	onclose: ((event: ICloseEvent) => void) | null = null
	onerror: ((error: Error) => void) | null = null
	onmessage: ((data: string) => void) | null = null

	constructor(ws: BunServerWebSocket, data: T) {
		this.ws = ws
		this.wsData = {
			userData: data,
			topics: new Set(),
		}
	}

	get data(): T {
		return this.wsData.userData
	}

	set data(value: T) {
		this.wsData.userData = value
	}

	get readyState(): WebSocketReadyState {
		return this.ws.readyState as WebSocketReadyState
	}

	send(data: string): void {
		if (this.ws.readyState === WebSocketReadyState.OPEN) {
			this.ws.send(data)
		}
	}

	close(code?: number, reason?: string): void {
		this.ws.close(code, reason)
	}

	subscribe(topic: string): void {
		this.ws.subscribe(topic)
		this.wsData.topics.add(topic)
	}

	unsubscribe(topic: string): void {
		this.ws.unsubscribe(topic)
		this.wsData.topics.delete(topic)
	}

	publish(topic: string, message: string): void {
		this.ws.publish(topic, message)
	}

	isSubscribed(topic: string): boolean {
		return this.wsData.topics.has(topic)
	}

	/**
	 * Get the underlying Bun WebSocket (for advanced use cases).
	 */
	getRawWebSocket(): BunServerWebSocket {
		return this.ws
	}
}

/**
 * Helper to create Bun WebSocket handlers that integrate with the transport layer.
 */
export interface BunWebSocketHandlers<T> {
	open: (ws: BunServerWebSocket) => void
	close: (ws: BunServerWebSocket, code: number, reason: string) => void
	message: (ws: BunServerWebSocket, message: string | Buffer) => void
	error: (ws: BunServerWebSocket, error: Error) => void
}

/**
 * Create Bun WebSocket handlers with adapter integration.
 */
export function createBunWebSocketHandlers<T>(callbacks: {
	onOpen: (ws: IServerWebSocket<T>) => void
	onClose: (ws: IServerWebSocket<T>, code: number, reason: string) => void
	onMessage: (ws: IServerWebSocket<T>, message: string) => void
	onError: (ws: IServerWebSocket<T>, error: Error) => void
	getData: (ws: BunServerWebSocket) => T
}): BunWebSocketHandlers<T> {
	// Map to store adapter instances
	const adapters = new WeakMap<BunServerWebSocket, BunServerWebSocketAdapter<T>>()

	const getOrCreateAdapter = (ws: BunServerWebSocket): BunServerWebSocketAdapter<T> => {
		let adapter = adapters.get(ws)
		if (!adapter) {
			adapter = new BunServerWebSocketAdapter(ws, callbacks.getData(ws))
			adapters.set(ws, adapter)
		}
		return adapter
	}

	return {
		open(ws: BunServerWebSocket) {
			const adapter = getOrCreateAdapter(ws)
			callbacks.onOpen(adapter)
		},

		close(ws: BunServerWebSocket, code: number, reason: string) {
			const adapter = adapters.get(ws)
			if (adapter) {
				callbacks.onClose(adapter, code, reason)
				adapters.delete(ws)
			}
		},

		message(ws: BunServerWebSocket, message: string | Buffer) {
			const adapter = getOrCreateAdapter(ws)
			// Convert Buffer to string if needed
			const data = typeof message === 'string' ? message : message.toString('utf-8')
			callbacks.onMessage(adapter, data)
		},

		error(ws: BunServerWebSocket, error: Error) {
			const adapter = getOrCreateAdapter(ws)
			callbacks.onError(adapter, error)
		},
	}
}

// Re-export types for convenience
export { WebSocketReadyState }
export type { ICloseEvent, IServerWebSocket, IWebSocket, IWebSocketFactory }
