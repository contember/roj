/**
 * Type-safe RPC Client
 *
 * Provides a fully typed interface for calling RPC methods.
 * All method names and input/output types are validated at compile time.
 *
 * Supports both single calls and batch calls:
 * - Single: rpc.call("method", input) -> Result<output, RpcErrorInfo>
 * - Batch:  rpc.batch(b => [b.add("m1", i1), b.add("m2", i2)]) -> Result<[o1, o2], RpcErrorInfo>
 */

import type { RpcInput, RpcMethodName, RpcOutput } from '@roj-ai/sdk/rpc'
import type { Result } from '../lib/result.js'
import { Err, Ok } from '../lib/result.js'

/**
 * Structured error info from RPC responses.
 */
export interface RpcErrorInfo {
	type: string
	message: string
	details?: unknown
}

/**
 * RPC error class for backwards compatibility.
 */
export class RpcError extends Error {
	constructor(
		public status: number,
		public error: RpcErrorInfo,
	) {
		super(error.message)
		this.name = 'RpcError'
	}
}

/**
 * RPC response envelope (new format).
 */
interface RpcResponse {
	ok: boolean
	value?: unknown
	error?: RpcErrorInfo
}

interface BatchResponse {
	results?: Array<{ ok: boolean; value?: unknown; error?: RpcErrorInfo }>
	ok?: boolean
	error?: RpcErrorInfo
}

/**
 * A typed marker for a batch call entry. Carries the output type at compile time.
 */
export interface BatchEntry<_T> {
	readonly method: string
	readonly input: unknown
}

/**
 * Batch call builder. Collects typed entries for a batch RPC request.
 */
export class BatchBuilder {
	add<M extends RpcMethodName>(method: M, input: RpcInput<M>): BatchEntry<RpcOutput<M>> {
		return { method, input }
	}
}

/**
 * Maps a tuple of BatchEntry<T> to a tuple of T.
 */
type BatchResults<T extends readonly BatchEntry<unknown>[]> = {
	[K in keyof T]: T[K] extends BatchEntry<infer R> ? R : never
}

/**
 * Type-safe RPC client for calling server methods.
 */
export class RpcClient {
	private projectId: string | null = null
	private authToken: string | null = null

	constructor(private baseUrl: string = '') {}

	/**
	 * Get the base URL for non-RPC requests.
	 */
	getBaseUrl(): string {
		return this.baseUrl
	}

	/**
	 * Set the project ID for DO-based RPC calls.
	 * When set, the projectId is added as a query parameter to /rpc requests.
	 */
	setProjectId(projectId: string | null): void {
		this.projectId = projectId
	}

	/**
	 * Get the currently configured project ID.
	 */
	getProjectId(): string | null {
		return this.projectId
	}

	/**
	 * Set the bearer token for authenticated RPC calls. Sent as
	 * `Authorization: Bearer <token>` so the platform doesn't have to fall
	 * back to cookie auth (which requires a separate `/exchange` round-trip
	 * and breaks under cross-origin third-party-cookie blocking).
	 */
	setAuthToken(token: string | null): void {
		this.authToken = token
	}

	/**
	 * Get the currently configured bearer token.
	 */
	getAuthToken(): string | null {
		return this.authToken
	}

	private getRpcUrl(): string {
		let url = `${this.baseUrl}/rpc`
		if (this.projectId) {
			url += `?project=${encodeURIComponent(this.projectId)}`
		}
		return url
	}

	private buildHeaders(extra: Record<string, string>): Record<string, string> {
		if (!this.authToken) return extra
		return { ...extra, Authorization: `Bearer ${this.authToken}` }
	}

	/**
	 * Call an RPC method with type-safe input and output.
	 */
	async call<M extends RpcMethodName>(
		method: M,
		input: RpcInput<M>,
	): Promise<Result<RpcOutput<M>, RpcErrorInfo>> {
		const response = await fetch(this.getRpcUrl(), {
			method: 'POST',
			headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify({ method, input }),
			credentials: 'include',
		})

		const data = (await response.json()) as RpcResponse

		// Transport error (non-200 for invalid JSON, missing method)
		if (!response.ok) {
			return Err(data.error ?? { type: 'transport_error', message: 'Request failed' })
		}

		// Application result
		if (data.ok) {
			return Ok(data.value as RpcOutput<M>)
		}

		return Err(data.error ?? { type: 'unknown_error', message: 'Unknown error' })
	}

	/**
	 * Execute multiple RPC calls as a batch.
	 */
	async batch<const T extends readonly BatchEntry<unknown>[]>(
		buildCalls: (b: BatchBuilder) => T,
	): Promise<Result<BatchResults<T>, RpcErrorInfo>> {
		const entries = buildCalls(new BatchBuilder())

		const response = await fetch(this.getRpcUrl(), {
			method: 'POST',
			headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify({
				batch: entries.map(e => ({ method: e.method, input: e.input })),
			}),
			credentials: 'include',
		})

		const data = (await response.json()) as BatchResponse

		// Transport error
		if (!response.ok) {
			return Err(data.error ?? { type: 'transport_error', message: 'Request failed' })
		}

		const results = data.results ?? []

		// Check if any call in the batch failed
		for (const entry of results) {
			if (!entry.ok && entry.error) {
				return Err(entry.error)
			}
		}

		// If fewer results than entries, the batch was short-circuited by an error
		if (results.length < entries.length) {
			const lastResult = results[results.length - 1]
			if (lastResult && !lastResult.ok && lastResult.error) {
				return Err(lastResult.error)
			}
			return Err({ type: 'batch_incomplete', message: 'Batch execution was interrupted' })
		}

		return Ok(results.map(r => r.value) as BatchResults<T>)
	}
}
