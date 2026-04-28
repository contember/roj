/**
 * Server Connection
 *
 * Represents a single client connection on the server side.
 * Simplified: no handshake - connection is ready immediately when attached.
 */

import { Connection } from '../core/connection.js'
import type { ConnectionConfig } from '../core/connection.js'
import type { HandlerContext, ProtocolDef } from '../core/protocol.js'
import type { IServerWebSocket } from '../platform/types.js'
import { WebSocketReadyState } from '../platform/types.js'

/**
 * Server connection configuration.
 */
export interface ServerConnectionConfig<TReceive extends ProtocolDef, TSend extends ProtocolDef> extends ConnectionConfig<TReceive, TSend> {
	connectionId?: string
}

/**
 * Extended handler context for server connections.
 */
export interface ServerHandlerContext extends HandlerContext {
	clientType?: string
	subscribedSessions: Set<string>
}

/**
 * Server-side WebSocket connection representing a single client.
 */
export class ServerConnection<TReceive extends ProtocolDef, TSend extends ProtocolDef> extends Connection<TReceive, TSend> {
	private serverWs: IServerWebSocket | null = null
	private clientType: string = 'unknown'
	private subscribedSessions = new Set<string>()

	constructor(config: ServerConnectionConfig<TReceive, TSend>) {
		super(config)
		if (config.connectionId) {
			this.connectionId = config.connectionId
		}
	}

	/**
	 * Attach an already-accepted WebSocket connection.
	 * Connection is immediately ready - no handshake needed.
	 */
	attach(ws: IServerWebSocket): void {
		this.serverWs = ws
		this.setupServerWebSocket(ws)
		this.setState('connected')
	}

	async connect(): Promise<void> {
		throw new Error('Server connections use attach() instead of connect()')
	}

	async disconnect(): Promise<void> {
		this.cleanup()

		if (this.serverWs && this.serverWs.readyState !== WebSocketReadyState.CLOSED) {
			this.serverWs.close(1000, 'Server disconnect')
		}

		this.serverWs = null
		this.ws = null
		this.setState('disconnected')
	}

	getClientType(): string {
		return this.clientType
	}

	setClientType(clientType: string): void {
		this.clientType = clientType
	}

	getSubscribedSessions(): ReadonlySet<string> {
		return this.subscribedSessions
	}

	subscribe(sessionId: string): void {
		this.subscribedSessions.add(sessionId)
		this.serverWs?.subscribe(`session:${sessionId}`)
	}

	unsubscribe(sessionId: string): void {
		this.subscribedSessions.delete(sessionId)
		this.serverWs?.unsubscribe(`session:${sessionId}`)
	}

	isSubscribedTo(sessionId: string): boolean {
		return this.subscribedSessions.has(sessionId)
	}

	publishToSession(sessionId: string, message: string): void {
		this.serverWs?.publish(`session:${sessionId}`, message)
	}

	getHandlerContext(): ServerHandlerContext {
		return {
			connectionId: this.connectionId,
			clientType: this.clientType,
			subscribedSessions: this.subscribedSessions,
		}
	}

	// Use server context for handlers
	private setupServerWebSocket(ws: IServerWebSocket): void {
		this.ws = ws
		this.router.setSender((message) => this.send(message))
		ws.onmessage = (data) => this.router.handleMessage(data, this.getHandlerContext())
		ws.onerror = (error) => this.emit('error', error)
		ws.onclose = (event) => this.handleClose(event.code, event.reason)
	}
}

export function createServerConnection<TReceive extends ProtocolDef, TSend extends ProtocolDef>(
	config: ServerConnectionConfig<TReceive, TSend>,
): ServerConnection<TReceive, TSend> {
	return new ServerConnection(config)
}
