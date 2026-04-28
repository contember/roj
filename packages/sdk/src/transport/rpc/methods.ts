/**
 * RPC Method Types
 *
 * Types are inferred from plugin definitions via the system composition.
 * Method schemas carry pre-resolved TS types (not Zod wrappers), so no z.infer needed.
 */

import type { BuiltinMethodSchemas } from '~/bootstrap.js'
import type { MethodSchema } from '~/core/system.js'

// ============================================================================
// RPC Method Types (inferred from system composition)
// ============================================================================

export type RpcMethods = BuiltinMethodSchemas
export type RpcMethodName = string & keyof RpcMethods

// Strip index signatures from mapped types (e.g. Zod v4's Record<string, never> for empty objects)
type RemoveIndexSignature<T> = {
	[K in keyof T as string extends K ? never : K]: T[K]
}

// Helper types to extract input/output types from method definitions
// Session methods (marked with __session) automatically include sessionId in input
// Types are already resolved in the brands — direct indexed access, no z.infer needed.
export type RpcInput<M extends RpcMethodName> = RpcMethods[M] extends { __session: true }
	? RemoveIndexSignature<RpcMethods[M]['input']> & { sessionId: string }
	: RpcMethods[M]['input']
export type RpcOutput<M extends RpcMethodName> = RpcMethods[M]['output']

// Method definition type (for handler implementations)
export type RpcMethodDef<M extends RpcMethodName> = {
	input: RpcMethods[M]['input']
	output: RpcMethods[M]['output']
}

// Generic method schema type — for consumers that need the shape without specific method names
export type { MethodSchema }
