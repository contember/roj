/**
 * Protocol Definition API
 *
 * Provides a type-safe way to define RPC-like protocols for WebSocket communication.
 * Inspired by tRPC but designed for bidirectional WebSocket protocols.
 */

import { z } from 'zod'
import type { Result } from './result.js'

// ============================================================================
// Method/Notification Definition Types
// ============================================================================

/**
 * Definition for a request-response method.
 */
export interface MethodDef<
	TInput extends z.ZodTypeAny = z.ZodTypeAny,
	TOutput extends z.ZodTypeAny = z.ZodTypeAny,
	TError extends z.ZodTypeAny = z.ZodTypeAny,
> {
	_type: 'method'
	input: TInput
	output: TOutput
	error: TError
}

/**
 * Definition for a fire-and-forget notification.
 */
export interface NotificationDef<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
	_type: 'notification'
	input: TInput
}

/**
 * A single endpoint definition (method or notification).
 */
export type EndpointDef = MethodDef | NotificationDef

/**
 * Protocol definition - a collection of named endpoints.
 */
export interface ProtocolDef {
	[key: string]: EndpointDef
}

// ============================================================================
// Type Inference Utilities
// ============================================================================

/**
 * Extract input type from an endpoint definition.
 */
export type InferInput<T extends EndpointDef> = T extends MethodDef<infer I, infer _O, infer _E> ? z.infer<I>
	: T extends NotificationDef<infer I> ? z.infer<I>
	: never

/**
 * Extract output type from a method definition.
 */
export type InferOutput<T extends MethodDef> = T extends MethodDef<infer _I, infer O, infer _E> ? z.infer<O>
	: never

/**
 * Extract error type from a method definition.
 */
export type InferError<T extends MethodDef> = T extends MethodDef<infer _I, infer _O, infer E> ? z.infer<E>
	: never

/**
 * Check if endpoint is a method.
 */
export type IsMethod<T extends EndpointDef> = T extends MethodDef ? true : false

/**
 * Check if endpoint is a notification.
 */
export type IsNotification<T extends EndpointDef> = T extends NotificationDef ? true : false

// ============================================================================
// Handler Types
// ============================================================================

/**
 * Handler context passed to method/notification handlers.
 */
export interface HandlerContext {
	/** Connection identifier */
	connectionId: string
	/** Additional context data (platform-specific) */
	[key: string]: unknown
}

/**
 * Handler for a method endpoint.
 */
export type MethodHandler<T extends MethodDef> = (
	input: InferInput<T>,
	ctx: HandlerContext,
) => Promise<Result<InferOutput<T>, InferError<T>>>

/**
 * Handler for a notification endpoint.
 */
export type NotificationHandler<T extends NotificationDef> = (
	input: InferInput<T>,
	ctx: HandlerContext,
) => Promise<void>

/**
 * Handler for an endpoint (method or notification).
 */
export type EndpointHandler<T extends EndpointDef> = T extends MethodDef ? MethodHandler<T>
	: T extends NotificationDef ? NotificationHandler<T>
	: never

/**
 * Handlers object for a protocol.
 */
export type ProtocolHandlers<T extends ProtocolDef> = {
	[K in keyof T]: EndpointHandler<T[K]>
}

// ============================================================================
// Caller Types (for making outbound calls)
// ============================================================================

/**
 * Caller function for a method endpoint.
 */
export type MethodCaller<T extends MethodDef> = (
	input: InferInput<T>,
) => Promise<Result<InferOutput<T>, InferError<T>>>

/**
 * Notifier function for a notification endpoint.
 */
export type NotificationNotifier<T extends NotificationDef> = (
	input: InferInput<T>,
) => void

/**
 * Caller object for methods in a protocol.
 * Only includes method endpoints.
 */
export type ProtocolCaller<T extends ProtocolDef> = {
	[K in keyof T as T[K] extends MethodDef ? K : never]: T[K] extends MethodDef ? MethodCaller<T[K]>
		: never
}

/**
 * Notifier object for notifications in a protocol.
 * Only includes notification endpoints.
 */
export type ProtocolNotifier<T extends ProtocolDef> = {
	[K in keyof T as T[K] extends NotificationDef ? K : never]: T[K] extends NotificationDef ? NotificationNotifier<T[K]>
		: never
}

// ============================================================================
// Definition Functions
// ============================================================================

/**
 * Options for method definition.
 */
export interface MethodOptions<
	TInput extends z.ZodTypeAny,
	TOutput extends z.ZodTypeAny,
	TError extends z.ZodTypeAny,
> {
	/** Input schema (what the caller sends) */
	input: TInput
	/** Output schema (what the handler returns on success) */
	output: TOutput
	/** Error schema (what the handler returns on failure) */
	error: TError
}

/**
 * Define a request-response method endpoint.
 */
export function method<
	TInput extends z.ZodTypeAny,
	TOutput extends z.ZodTypeAny,
	TError extends z.ZodTypeAny,
>(options: MethodOptions<TInput, TOutput, TError>): MethodDef<TInput, TOutput, TError> {
	return {
		_type: 'method',
		input: options.input,
		output: options.output,
		error: options.error,
	}
}

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

/**
 * Protocol object with definition and metadata.
 */
export interface Protocol<T extends ProtocolDef> {
	/** The protocol definition */
	_def: T
	/** Get endpoint definition by name */
	getEndpoint<K extends keyof T>(name: K): T[K]
	/** Check if endpoint is a method */
	isMethod(name: keyof T): boolean
	/** Check if endpoint is a notification */
	isNotification(name: keyof T): boolean
	/** Get all method names */
	getMethodNames(): (keyof T)[]
	/** Get all notification names */
	getNotificationNames(): (keyof T)[]
	/** Validate input for an endpoint */
	validateInput<K extends keyof T>(name: K, input: unknown): SafeParseResult<InferInput<T[K]>>
	/** Validate output for a method endpoint */
	validateOutput<K extends keyof T>(name: K, output: unknown): SafeParseResult<unknown>
}

/**
 * Define a protocol with typed endpoints.
 *
 * @example
 * ```typescript
 * const clientProtocol = defineProtocol({
 *   subscribe: method({
 *     input: z.object({ sessionId: z.string() }),
 *     output: z.void(),
 *     error: z.object({ code: z.literal('SESSION_NOT_FOUND') }),
 *   }),
 *
 *   userMessage: method({
 *     input: z.object({ sessionId: z.string(), content: z.string() }),
 *     output: z.object({ messageId: z.string() }),
 *     error: z.object({ code: z.literal('AGENT_BUSY') }),
 *   }),
 * });
 *
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

		getEndpoint<K extends keyof T>(name: K): T[K] {
			return def[name]
		},

		isMethod(name: keyof T): boolean {
			const endpoint = def[name]
			return endpoint?._type === 'method'
		},

		isNotification(name: keyof T): boolean {
			const endpoint = def[name]
			return endpoint?._type === 'notification'
		},

		getMethodNames(): (keyof T)[] {
			return Object.keys(def).filter((key) => def[key]._type === 'method') as (keyof T)[]
		},

		getNotificationNames(): (keyof T)[] {
			return Object.keys(def).filter((key) => def[key]._type === 'notification') as (keyof T)[]
		},

		validateInput<K extends keyof T>(name: K, input: unknown): SafeParseResult<InferInput<T[K]>> {
			const endpoint = def[name]
			const result = endpoint.input.safeParse(input)
			if (result.success) {
				return { success: true, data: result.data as InferInput<T[K]> }
			}
			return { success: false, error: { message: result.error.message } }
		},

		validateOutput<K extends keyof T>(name: K, output: unknown): SafeParseResult<unknown> {
			const endpoint = def[name]
			if (endpoint._type !== 'method') {
				throw new Error(`Endpoint ${String(name)} is not a method`)
			}
			const result = endpoint.output.safeParse(output)
			if (result.success) {
				return { success: true, data: result.data }
			}
			return { success: false, error: { message: result.error.message } }
		},
	}
}

// ============================================================================
// Type Extraction Helpers
// ============================================================================

/**
 * Extract the protocol definition type from a Protocol.
 */
export type ExtractProtocolDef<T> = T extends Protocol<infer P> ? P : never

/**
 * Create a typed handlers object type for a protocol.
 */
export type HandlersFor<T extends Protocol<ProtocolDef>> = ProtocolHandlers<ExtractProtocolDef<T>>

/**
 * Create a typed caller object type for a protocol.
 */
export type CallerFor<T extends Protocol<ProtocolDef>> = ProtocolCaller<ExtractProtocolDef<T>>

/**
 * Create a typed notifier object type for a protocol.
 */
export type NotifierFor<T extends Protocol<ProtocolDef>> = ProtocolNotifier<ExtractProtocolDef<T>>
