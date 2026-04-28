/**
 * Type-safe RPC client.
 * Mirrors the method definitions for compile-time safety.
 *
 * Usage:
 *   const client = createRpcClient<PlatformMethods>('https://api.roj.cloud/rpc', {
 *     headers: { Authorization: `Bearer ${apiKey}` },
 *   })
 *   const result = await client.call('instances.create', { ... })
 */
import type { MethodDef, MethodInput, MethodOutput, RpcError, RpcResponse } from './rpc-definition'

export interface RpcClientOptions {
	headers?: Record<string, string>
	credentials?: RequestCredentials
}

export interface RpcClient<Methods extends Record<string, MethodDef>> {
	call<M extends string & keyof Methods>(
		method: M,
		input: MethodInput<Methods, M>,
	): Promise<RpcResult<MethodOutput<Methods, M>>>
}

export type RpcResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: RpcError }

export function createRpcClient<Methods extends Record<string, MethodDef>>(
	baseUrl: string,
	options?: RpcClientOptions,
): RpcClient<Methods> {
	return {
		async call<M extends string & keyof Methods>(
			method: M,
			input: MethodInput<Methods, M>,
		): Promise<RpcResult<MethodOutput<Methods, M>>> {
			const response = await fetch(`${baseUrl}/rpc`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...options?.headers,
				},
				credentials: options?.credentials,
				body: JSON.stringify({ method, input }),
			})

			const data = (await response.json()) as RpcResponse

			if (!response.ok) {
				return {
					ok: false,
					error: data.error ?? { type: 'transport_error', message: `HTTP ${response.status}` },
				}
			}

			if (data.ok) {
				return { ok: true, value: data.value as MethodOutput<Methods, M> }
			}

			return {
				ok: false,
				error: data.error ?? { type: 'unknown_error', message: 'Unknown error' },
			}
		},
	}
}
