/**
 * @roj-ai/transport
 *
 * Platform-agnostic WebSocket transport infrastructure with a typed notification protocol API.
 */

// ============================================================================
// Core Exports
// ============================================================================

// Protocol Definition API
export { defineProtocol, notification } from './core/protocol.js'
export type {
	HandlerContext,
	InferInput,
	NotificationDef,
	NotificationHandler,
	NotificationNotifier,
	NotificationOptions,
	Protocol,
	ProtocolDef,
	ProtocolHandlers,
	ProtocolNotifier,
	SafeParseResult,
} from './core/protocol.js'

// Result Type
export { Err, flatMapResult, isErr, isOk, mapResult, Ok, unwrapOr, unwrapOrThrow } from './core/result.js'
export type { Result } from './core/result.js'

// Types
export type { ConnectionState, ReconnectOptions, TransportEvent, TransportEventListener, WireMessage } from './core/types.js'

export { DEFAULT_RECONNECT_OPTIONS } from './core/types.js'

// Core Components
export { createRouter, MessageRouter } from './core/router.js'
export type { MessageSender, RawMessageListener, RouterErrorHandler, RouterErrorType } from './core/router.js'

export { Connection } from './core/connection.js'
export type { ConnectionConfig } from './core/connection.js'

// ============================================================================
// Platform Exports
// ============================================================================

export type { ICloseEvent, IServerWebSocket, IWebSocket, IWebSocketFactory } from './platform/types.js'

export { WebSocketReadyState } from './platform/types.js'

// ============================================================================
// Client Exports
// ============================================================================

export { ClientConnection, createClientConnection } from './client/client-connection.js'
export type { ClientConnectionConfig } from './client/client-connection.js'

// ============================================================================
// Server Exports
// ============================================================================

export { createServerConnection, ServerConnection } from './server/server-connection.js'
export type { ServerConnectionConfig, ServerHandlerContext } from './server/server-connection.js'

export { ConnectionManager } from './server/connection-manager.js'
export type { ConnectionStats } from './server/connection-manager.js'
