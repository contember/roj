import { BatchBuilder, type BatchEntry, RpcClient, RpcError } from '@roj-ai/shared/rpc'
import type { Result, RpcErrorInfo, RpcInput, RpcMethodName, RpcOutput } from '@roj-ai/shared/rpc'
import type { InstanceMethods } from '../platform/instance-methods.js'
import type { MethodInput, MethodOutput } from '../platform/rpc-definition.js'

export { BatchBuilder, RpcClient, RpcError }
export type { BatchEntry, RpcErrorInfo }

type BatchResults<T extends readonly BatchEntry<unknown>[]> = {
	[K in keyof T]: T[K] extends BatchEntry<infer R> ? R : never
}

export interface ApiClient {
	call<M extends RpcMethodName>(method: M, input: RpcInput<M>): Promise<Result<RpcOutput<M>, RpcErrorInfo>>
	batch<const T extends readonly BatchEntry<unknown>[]>(
		buildCalls: (b: BatchBuilder) => T,
	): Promise<Result<BatchResults<T>, RpcErrorInfo>>
	/** Synchronous upload — server blocks until preprocessing finishes. Kept for backwards compat. */
	uploadFile(sessionId: string, file: File): Promise<{ uploadId: string; status: 'ready' | 'failed'; extractedContent?: string }>
	/**
	 * Async upload — returns as soon as the file lands on disk. Caller listens
	 * for `uploads.uploadStatusChanged` notifications (or polls
	 * `uploads.listPending`) to learn when preprocessing finishes.
	 */
	uploadFileAsync(sessionId: string, file: File): Promise<{ uploadId: string; status: 'processing' }>
}

/**
 * Typed RPC client for instance-scoped platform methods (sandbox lifecycle,
 * service URLs, session management). Shares transport, base URL, and auth
 * token with `api`, so the same `configureApiBaseUrl` / `configureAuthToken`
 * configuration applies. Use this for anything defined in
 * `@roj-ai/client/platform` `instanceMethods` — calling those via raw `fetch`
 * skips the auth header and fails with `no_credential` against the platform's
 * instance route.
 */
export interface InstanceApiClient {
	call<M extends string & keyof InstanceMethods>(
		method: M,
		input: MethodInput<InstanceMethods, M>,
	): Promise<Result<MethodOutput<InstanceMethods, M>, RpcErrorInfo>>
}

function createInstanceApiFromRpc(getClient: () => RpcClient): InstanceApiClient {
	return {
		call: (method, input) =>
			getClient().callUntyped(method, input) as ReturnType<InstanceApiClient['call']>,
	}
}

function createApiClientFromRpc(getClient: () => RpcClient): ApiClient {
	return {
		call: (method, input) => getClient().call(method, input),
		batch: (buildCalls) => getClient().batch(buildCalls),
		uploadFile(sessionId, file) {
			return postUpload(getClient(), sessionId, file, 'upload')
		},
		uploadFileAsync(sessionId, file) {
			return postUpload(getClient(), sessionId, file, 'upload-async')
		},
	}
}

async function postUpload<T>(
	client: RpcClient,
	sessionId: string,
	file: File,
	pathSuffix: 'upload' | 'upload-async',
): Promise<T> {
	const formData = new FormData()
	formData.append('file', file)

	const baseUrl = client.getBaseUrl()
	const projectId = client.getProjectId()
	const authToken = client.getAuthToken()
	let url = `${baseUrl}/sessions/${sessionId}/${pathSuffix}`
	if (projectId) {
		url += `?project=${encodeURIComponent(projectId)}`
	}
	const headers: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {}
	const response = await fetch(url, {
		method: 'POST',
		body: formData,
		headers,
		credentials: 'include',
	})

	if (!response.ok) {
		const error = await response.json() as { error?: { message?: string } }
		throw new Error(error.error?.message || 'Upload failed')
	}

	return response.json()
}

let rpcClient = new RpcClient('')

export function configureApiBaseUrl(url: string): void {
	const projectId = rpcClient.getProjectId()
	const authToken = rpcClient.getAuthToken()
	rpcClient = new RpcClient(url)
	if (projectId) {
		rpcClient.setProjectId(projectId)
	}
	if (authToken) {
		rpcClient.setAuthToken(authToken)
	}
}

export function getApiBaseUrl(): string {
	return rpcClient.getBaseUrl()
}

export function configureProjectId(projectId: string | null): void {
	rpcClient.setProjectId(projectId)
}

/**
 * Set the bearer token used by the shared `api` client for authenticated
 * RPC calls. Sent as `Authorization: Bearer <token>` so the platform doesn't
 * have to fall back to cookie auth.
 *
 * `useChat` calls this automatically when given a token; host code only
 * needs it when constructing API calls outside of `useChat` (e.g. server-
 * side scripts or custom hooks).
 */
export function configureAuthToken(token: string | null): void {
	rpcClient.setAuthToken(token)
}

export function createApiClient(baseUrl: string = ''): ApiClient {
	const client = new RpcClient(baseUrl)
	return createApiClientFromRpc(() => client)
}

export const api: ApiClient = createApiClientFromRpc(() => rpcClient)

/**
 * Singleton instance-RPC client wrapping the same shared `rpcClient` as `api`.
 * Picks up base URL and bearer token configured via
 * `configureApiBaseUrl` / `configureAuthToken`.
 */
export const instanceApi: InstanceApiClient = createInstanceApiFromRpc(() => rpcClient)

export function useApiError(error: unknown): string | null {
	if (error instanceof RpcError) {
		return error.error.message
	}
	if (error instanceof Error) {
		return error.message
	}
	return null
}
