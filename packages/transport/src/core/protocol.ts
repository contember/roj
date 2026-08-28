/**
 * Protocol Definition API
 *
 * Type-safe definition of the notification protocols carried over the WebSocket
 * link. Fire-and-forget only — request/response lives on HTTP `/rpc`.
 */

import { z } from 'zod'

// ============================================================================
// Notification Definition Types
// ============================================================================

/**
 * Definition for a fire-and-forget notification.
 */
export interface NotificationDef<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
	_type: 'notification'
	input: TInput
}

/**
 * Protocol definition - a collection of named notifications.
 */
export interface ProtocolDef {
	[key: string]: NotificationDef
}

// ============================================================================
// Type Inference Utilities
// ============================================================================

/**
 * Extract input type from a notification definition.
 */
export type InferInput<T extends NotificationDef> = z.infer<T['input']>

// ============================================================================
// Handler Types
// ============================================================================

/**
 * Handler context passed to notification handlers.
 */
export interface HandlerContext {
	/** Connection identifier */
	connectionId: string
	/** Additional context data (platform-specific) */
	[key: string]: unknown
}

/**
 * Handler for a notification endpoint.
 */
export type NotificationHandler<T extends NotificationDef> = (
	input: InferInput<T>,
	ctx: HandlerContext,
) => Promise<void>

/**
 * Handlers object for a protocol.
 */
export type ProtocolHandlers<T extends ProtocolDef> = {
	[K in keyof T]: NotificationHandler<T[K]>
}

// ============================================================================
// Notifier Types (for making outbound calls)
// ============================================================================

/**
 * Notifier function for a notification endpoint.
 */
export type NotificationNotifier<T extends NotificationDef> = (
	input: InferInput<T>,
) => void

/**
 * Notifier object for the notifications in a protocol.
 */
export type ProtocolNotifier<T extends ProtocolDef> = {
	[K in keyof T]: NotificationNotifier<T[K]>
}

// ============================================================================
// Definition Functions
// ============================================================================

/**
 * Options for notification definition.
 */
export interface NotificationOptions<TInput extends z.ZodTypeAny> {
	/** Input schema (what is sent) */
	input: TInput
}

/**
 * Define a fire-and-forget notification endpoint.
 */
export function notification<TInput extends z.ZodTypeAny>(
	options: NotificationOptions<TInput>,
): NotificationDef<TInput> {
	return {
		_type: 'notification',
		input: options.input,
	}
}

// ============================================================================
// Protocol Definition
// ============================================================================

/**
 * Safe parse result type (matches Zod's structure).
 */
export type SafeParseResult<T> =
	| { success: true; data: T }
	| { success: false; error: { message: string } }

/** Parse through a generic schema type so the result keeps the schema's output type. */
function safeParseWith<S extends z.ZodTypeAny>(schema: S, input: unknown): SafeParseResult<z.infer<S>> {
	const result = schema.safeParse(input)
	if (result.success) {
		return { success: true, data: result.data }
	}
	return { success: false, error: { message: result.error.message } }
}

/**
 * Protocol object with definition and metadata.
 */
export interface Protocol<T extends ProtocolDef> {
	/** The protocol definition */
	_def: T
	/** Get all notification names */
	getNotificationNames(): (keyof T)[]
	/** Validate input for a notification */
	validateInput<K extends keyof T>(name: K, input: unknown): SafeParseResult<InferInput<T[K]>>
}

/**
 * Define a protocol with typed notifications.
 *
 * @example
 * ```typescript
 * const serverProtocol = defineProtocol({
 *   agentMessage: notification({
 *     input: z.object({ sessionId: z.string(), content: z.string() }),
 *   }),
 * });
 * ```
 */
export function defineProtocol<T extends ProtocolDef>(def: T): Protocol<T> {
	return {
		_def: def,

		getNotificationNames(): (keyof T)[] {
			return Object.keys(def)
		},

		validateInput<K extends keyof T>(name: K, input: unknown): SafeParseResult<InferInput<T[K]>> {
			return safeParseWith<T[K]['input']>(def[name].input, input)
		},
	}
}
