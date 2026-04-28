import { RpcClient, RpcError } from '@roj-ai/shared/rpc'
import type { Result, RpcErrorInfo, RpcInput, RpcMethodName, RpcOutput } from '@roj-ai/shared/rpc'

export { RpcClient, RpcError }
export type { RpcErrorInfo }

export interface ApiClient {
	call<M extends RpcMethodName>(method: M, input: RpcInput<M>): Promise<Result<RpcOutput<M>, RpcErrorInfo>>
	uploadFile(sessionId: string, file: File): Promise<{ uploadId: string; status: 'ready' | 'failed'; extractedContent?: string }>
}

function createApiClientFromRpc(getClient: () => RpcClient): ApiClient {
	return {
		call: (method, input) => getClient().call(method, input),
		async uploadFile(sessionId, file) {
			const formData = new FormData()
			formData.append('file', file)

			const client = getClient()
			const baseUrl = client.getBaseUrl()
			const projectId = client.getProjectId()
			let url = `${baseUrl}/sessions/${sessionId}/upload`
			if (projectId) {
				url += `?project=${encodeURIComponent(projectId)}`
			}
			const response = await fetch(url, {
				method: 'POST',
				body: formData,
				credentials: 'include',
			})

			if (!response.ok) {
				const error = await response.json() as { error?: { message?: string } }
				throw new Error(error.error?.message || 'Upload failed')
			}

			return response.json()
		},
	}
}

let rpcClient = new RpcClient('')

export function configureApiBaseUrl(url: string): void {
	const projectId = rpcClient.getProjectId()
	rpcClient = new RpcClient(url)
	if (projectId) {
		rpcClient.setProjectId(projectId)
	}
}

export function getApiBaseUrl(): string {
	return rpcClient.getBaseUrl()
}

export function configureProjectId(projectId: string | null): void {
	rpcClient.setProjectId(projectId)
}

export function createApiClient(baseUrl: string = ''): ApiClient {
	const client = new RpcClient(baseUrl)
	return createApiClientFromRpc(() => client)
}

export const api: ApiClient = createApiClientFromRpc(() => rpcClient)

export function useApiError(error: unknown): string | null {
	if (error instanceof RpcError) {
		return error.error.message
	}
	if (error instanceof Error) {
		return error.message
	}
	return null
}
