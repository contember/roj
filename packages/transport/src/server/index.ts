/**
 * Server Connection Module
 *
 * WebSocket server for handling incoming client connections.
 */

export { createServerConnection, ServerConnection } from './server-connection.js'
export type { ServerConnectionConfig, ServerHandlerContext } from './server-connection.js'

export { ConnectionManager } from './connection-manager.js'
export type { ConnectionStats } from './connection-manager.js'

// Re-export core types commonly used with server
export type {
	ConnectionState,
	HandlerContext,
	Protocol,
	ProtocolCaller,
	ProtocolDef,
	ProtocolHandlers,
	ProtocolNotifier,
	TransportEvent,
	TransportEventListener,
} from '../core/index.js'

export { defineProtocol, method, notification } from '../core/index.js'
