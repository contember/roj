import { createRpcClient } from './rpc-client'
import type { MethodInput, MethodOutput } from './rpc-definition'
import type { PlatformMethods, PlatformMethodName } from './methods'
import type {
	CreateInstanceInput,
	CreateInstanceOutput,
	GetInstanceOutput,
	GetInstanceStatusOutput,
	ListInstancesInput,
	ListInstancesOutput,
	ArchiveInstanceOutput,
	CreateSessionInput,
	CreateSessionOutput,
	ListSessionsOutput,
	PublishSessionInput,
	PublishSessionOutput,
	CreateInstanceTokenInput,
	CreateInstanceTokenOutput,
	ListBundlesInput,
	ListBundlesOutput,
	DeleteBundleOutput,
	CreateResourceInput,
	CreateResourceOutput,
	AddResourceRevisionInput,
	AddResourceRevisionOutput,
	GetResourceInput,
	GetResourceOutput,
	ListResourcesInput,
	ListResourcesOutput,
	DeleteResourceOutput,
} from './methods'
import { RojApiError } from './errors'

export interface RojClientOptions {
	/** Platform URL (e.g. https://roj.example.com) */
	url: string
	/** Platform API key */
	apiKey: string
}

export interface RojClient {
	instances: {
		create(input: CreateInstanceInput): Promise<CreateInstanceOutput>
		get(instanceId: string): Promise<GetInstanceOutput>
		getStatus(instanceId: string): Promise<GetInstanceStatusOutput>
		list(input?: ListInstancesInput): Promise<ListInstancesOutput>
		archive(instanceId: string): Promise<ArchiveInstanceOutput>
	}
	sessions: {
		create(input: CreateSessionInput): Promise<CreateSessionOutput>
		list(instanceId: string): Promise<ListSessionsOutput>
		publish(input: PublishSessionInput): Promise<PublishSessionOutput>
	}
	tokens: {
		create(input: CreateInstanceTokenInput): Promise<CreateInstanceTokenOutput>
	}
	bundles: {
		list(input?: ListBundlesInput): Promise<ListBundlesOutput>
		delete(input: { bundleId?: string; bundleSlug?: string }): Promise<DeleteBundleOutput>
	}
	files: {
		upload(file: File | Blob, filename?: string): Promise<{ ok: true; fileId: string; filename: string; mimeType: string; size: number; r2Key: string }>
	}
	resources: {
		create(input: CreateResourceInput): Promise<CreateResourceOutput>
		addRevision(input: AddResourceRevisionInput): Promise<AddResourceRevisionOutput>
		get(input: GetResourceInput): Promise<GetResourceOutput>
		list(input?: ListResourcesInput): Promise<ListResourcesOutput>
		delete(resourceId: string): Promise<DeleteResourceOutput>
	}
}

export function createRojClient(options: RojClientOptions): RojClient {
	const rpc = createRpcClient<PlatformMethods>(`${options.url}/api/v1`, {
		headers: { Authorization: `Bearer ${options.apiKey}` },
	})

	async function call<M extends PlatformMethodName>(
		method: M,
		input: MethodInput<PlatformMethods, M>,
	): Promise<MethodOutput<PlatformMethods, M>> {
		const result = await rpc.call(method, input)
		if (!result.ok) throw new RojApiError(result.error)
		return result.value
	}

	return {
		instances: {
			create: (input) => call('instances.create', input),
			get: (instanceId) => call('instances.get', { instanceId }),
			getStatus: (instanceId) => call('instances.status', { instanceId }),
			list: (input) => call('instances.list', input ?? {}),
			archive: (instanceId) => call('instances.archive', { instanceId }),
		},
		sessions: {
			create: (input) => call('sessions.create', input),
			list: (instanceId) => call('sessions.list', { instanceId }),
			publish: (input) => call('sessions.publish', input),
		},
		tokens: {
			create: (input) => call('tokens.create', input),
		},
		bundles: {
			list: (input) => call('bundles.list', input ?? {}),
			delete: (input) => call('bundles.delete', input),
		},
		files: {
			upload: async (file, filename) => {
				const formData = new FormData()
				formData.append('file', file, filename)
				const response = await fetch(`${options.url}/api/v1/files/upload`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${options.apiKey}` },
					body: formData,
				})
				if (!response.ok) {
					const body = await response.json().catch(() => ({ message: response.statusText }))
					throw new RojApiError({ type: 'http_error', message: body.error ?? body.message ?? response.statusText })
				}
				return response.json()
			},
		},
		resources: {
			create: (input) => call('resources.create', input),
			addRevision: (input) => call('resources.addRevision', input),
			get: (input) => call('resources.get', input),
			list: (input) => call('resources.list', input ?? {}),
			delete: (resourceId) => call('resources.delete', { resourceId }),
		},
	}
}
