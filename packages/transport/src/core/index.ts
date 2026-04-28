/**
 * Core Transport Module
 *
 * Platform-agnostic WebSocket infrastructure.
 */

// Types
export type { ConnectionState, ReconnectOptions, TransportEvent, TransportEventListener, WireMessage } from './types.js'

export { DEFAULT_RECONNECT_OPTIONS } from './types.js'

// Result
export type { Result } from './result.js'
export { Err, flatMapResult, isErr, isOk, mapResult, Ok, unwrapOr, unwrapOrThrow } from './result.js'

// Protocol Definition
export { defineProtocol, method, notification } from './protocol.js'
export type {
	CallerFor,
	EndpointDef,
	EndpointHandler,
	ExtractProtocolDef,
	HandlerContext,
	HandlersFor,
	InferError,
	InferInput,
	InferOutput,
	IsMethod,
	IsNotification,
	MethodCaller,
	MethodDef,
	MethodHandler,
	MethodOptions,
	NotificationDef,
	NotificationHandler,
	NotificationNotifier,
	NotificationOptions,
	NotifierFor,
	Protocol,
	ProtocolCaller,
	ProtocolDef,
	ProtocolHandlers,
	ProtocolNotifier,
} from './protocol.js'

// Message Router
export { createRouter, MessageRouter } from './router.js'
export type { MessageSender } from './router.js'

// Connection Base
export { Connection } from './connection.js'
export type { ConnectionConfig } from './connection.js'
