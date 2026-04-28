/**
 * Type-safe RPC definition system.
 * No external dependencies — just TypeScript types + minimal runtime.
 *
 * Usage:
 *   const methods = defineMethods({
 *     'instances.create': method<CreateInput, CreateOutput>(),
 *     'sessions.list': method<ListInput, ListOutput>(),
 *   })
 */

/** Marker type for a method definition (input → output). */
export interface MethodDef<I = unknown, O = unknown> {
	readonly _input: I
	readonly _output: O
}

/** Define a method type. Zero runtime cost — just a type marker. */
export function method<I, O>(): MethodDef<I, O> {
	return {} as MethodDef<I, O>
}

/** Define a set of methods. Returns the definition object as-is (typed). */
export function defineMethods<T extends Record<string, MethodDef>>(methods: T): T {
	return methods
}

/** Extract input type from a method name. */
export type MethodInput<
	Methods extends Record<string, MethodDef>,
	M extends keyof Methods,
> = Methods[M]['_input']

/** Extract output type from a method name. */
export type MethodOutput<
	Methods extends Record<string, MethodDef>,
	M extends keyof Methods,
> = Methods[M]['_output']

/** RPC request envelope. */
export interface RpcRequest<M extends string = string> {
	method: M
	input: unknown
}

/** RPC response envelope. */
export interface RpcResponse<T = unknown> {
	ok: boolean
	value?: T
	error?: RpcError
}

export interface RpcError {
	type: string
	message: string
	details?: unknown
}
