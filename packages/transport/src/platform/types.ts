/**
 * Platform Abstraction Types
 *
 * Common interfaces for WebSocket implementations across platforms (browser + Bun).
 */

/**
 * WebSocket ready state values.
 */
export const WebSocketReadyState = {
	CONNECTING: 0,
	OPEN: 1,
	CLOSING: 2,
	CLOSED: 3,
} as const

export type WebSocketReadyState = (typeof WebSocketReadyState)[keyof typeof WebSocketReadyState]

/**
 * Close event structure.
 */
export interface ICloseEvent {
	code: number
	reason: string
}

/**
 * Platform-agnostic WebSocket interface.
 */
export interface IWebSocket {
	/** Current ready state */
	readonly readyState: WebSocketReadyState

	/** Send a text message */
	send(data: string): void

	/** Close the connection */
	close(code?: number, reason?: string): void

	/** Called when connection opens */
	onopen: (() => void) | null

	/** Called when connection closes */
	onclose: ((event: ICloseEvent) => void) | null

	/** Called on error */
	onerror: ((error: Error) => void) | null

	/** Called when a message is received */
	onmessage: ((data: string) => void) | null
}

/**
 * Factory for creating WebSocket client connections.
 */
export interface IWebSocketFactory {
	/** Create a new WebSocket connection to the given URL */
	create(url: string): IWebSocket
}

/**
 * Server-side WebSocket interface (for handling incoming connections).
 * Extended from IWebSocket with server-specific capabilities.
 */
export interface IServerWebSocket<T = unknown> extends IWebSocket {
	/** Attached data for this connection */
	data: T

	/** Subscribe to a topic for pub/sub messaging */
	subscribe(topic: string): void

	/** Unsubscribe from a topic */
	unsubscribe(topic: string): void

	/** Publish to a topic (message sent to all subscribers except sender) */
	publish(topic: string, message: string): void

	/** Check if subscribed to a topic */
	isSubscribed(topic: string): boolean
}

/**
 * WebSocket server upgrade request data.
 */
export interface IUpgradeData<T = unknown> {
	/** Data to attach to the WebSocket connection */
	data: T
}

/**
 * WebSocket server interface for handling multiple connections.
 */
export interface IWebSocketServer<T = unknown> {
	/** Handle WebSocket upgrade from HTTP request */
	upgrade(request: Request, data: T): boolean

	/** Publish to all connections subscribed to a topic */
	publish(topic: string, message: string): void

	/** Get all active connections */
	getConnections(): Iterable<IServerWebSocket<T>>
}
