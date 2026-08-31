/**
 * Client Connection Module
 *
 * WebSocket client for connecting to server endpoints.
 */

export { ClientConnection, createClientConnection } from './client-connection.js'
export type { ClientConnectionConfig } from './client-connection.js'

// Re-export core types commonly used with client
export type {
	ConnectionState,
	HandlerContext,
	Protocol,
	ProtocolDef,
	ProtocolHandlers,
	ProtocolNotifier,
	SafeParseResult,
	ReconnectOptions,
	TransportEvent,
	TransportEventListener,
} from '../core/index.js'

export { defineProtocol, notification } from '../core/index.js'
