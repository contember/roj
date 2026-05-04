import { createRpcClient } from './rpc-client.js'
import type { MethodInput, MethodOutput } from './rpc-definition.js'
import type { PlatformMethods, PlatformMethodName } from './methods.js'
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
	CreateSessionFileDownloadUrlInput,
	CreateSessionFileDownloadUrlOutput,
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
} from './methods.js'
import { RojApiError } from './errors.js'

export interface RojClientOptions {
	/** Platform URL (e.g. https://roj.example.com) */
	url: string
	/** Platform API key */
	apiKey: string
}

export interface SessionRpcInput {
	instanceId: string
	sessionId: string
	method: string
	input?: Record<string, unknown>
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
		/**
		 * Call a plugin/session RPC method on a running session.
		 *
		 * Auto-mints and caches an instance token; the cached token is reused until
		 * its expiry minus a small leeway. Suitable for server-to-server callers
		 * that don't have a browser cookie or pre-existing instance token.
		 */
		rpc<T = unknown>(input: SessionRpcInput): Promise<T>
	}
	tokens: {
		create(input: CreateInstanceTokenInput): Promise<CreateInstanceTokenOutput>
	}
	sessionFiles: {
		/**
		 * Mint a short-lived signed URL that streams the bytes of a session-bound file
		 * back to the caller. Use after a session plugin has produced an artifact
		 * (e.g. workspace `dist/Course.zip`) and the caller wants to fetch it without
		 * routing through the dev preview proxy. `scope` selects between the workspace
		 * dir and the SDK's session storage.
		 */
		createDownloadUrl(input: CreateSessionFileDownloadUrlInput): Promise<CreateSessionFileDownloadUrlOutput>
	}
	bundles: {
		list(input?: ListBundlesInput): Promise<ListBundlesOutput>
		delete(input: { bundleId?: string; bundleSlug?: string }): Promise<DeleteBundleOutput>
	}
	files: {
		upload(file: File | Blob, filename?: string): Promise<{ ok: true; fileId: string; filename: string; mimeType: string; size: number; r2Key: string; deduped: boolean }>
	}
	resources: {
		create(input: CreateResourceInput): Promise<CreateResourceOutput>
		addRevision(input: AddResourceRevisionInput): Promise<AddResourceRevisionOutput>
		get(input: GetResourceInput): Promise<GetResourceOutput>
		list(input?: ListResourcesInput): Promise<ListResourcesOutput>
		delete(resourceId: string): Promise<DeleteResourceOutput>
	}
}

// Re-mint instance tokens this many milliseconds before their server-stated expiry.
// Covers both clock skew between client and server and the latency of an in-flight
// session RPC that started just before expiry.
const TOKEN_REFRESH_LEEWAY_MS = 30_000

interface CachedToken {
	token: string
	expiresAtMs: number
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

	const instanceTokenCache = new Map<string, CachedToken>()
	const inflightTokenMint = new Map<string, Promise<string>>()
	async function getInstanceToken(instanceId: string): Promise<string> {
		const cached = instanceTokenCache.get(instanceId)
		if (cached && cached.expiresAtMs - TOKEN_REFRESH_LEEWAY_MS > Date.now()) {
			return cached.token
		}
		const inflight = inflightTokenMint.get(instanceId)
		if (inflight) return inflight
		const promise = (async () => {
			try {
				const fresh = await call('tokens.create', { instanceId })
				instanceTokenCache.set(instanceId, {
					token: fresh.token,
					expiresAtMs: new Date(fresh.expiresAt).getTime(),
				})
				return fresh.token
			} finally {
				inflightTokenMint.delete(instanceId)
			}
		})()
		inflightTokenMint.set(instanceId, promise)
		return promise
	}

	async function callSessionRpc<T>(input: SessionRpcInput, retriedAfter401 = false): Promise<T> {
		const token = await getInstanceToken(input.instanceId)
		const url = `${options.url}/api/v1/instances/${input.instanceId}/sessions/${input.sessionId}/rpc`
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ method: input.method, input: input.input ?? {} }),
		})
		// Token may have been revoked or rotated server-side before its stated `expiresAt`.
		// Evict the cache and retry once with a freshly minted token.
		if (response.status === 401 && !retriedAfter401) {
			instanceTokenCache.delete(input.instanceId)
			return callSessionRpc<T>(input, true)
		}
		const body = await response.json().catch(() => null) as { ok?: boolean; value?: unknown; error?: { type: string; message: string } } | null
		if (!response.ok || !body || body.ok === false) {
			const error = body?.error ?? { type: 'transport_error', message: `HTTP ${response.status}` }
			throw new RojApiError(error)
		}
		return body.value as T
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
			rpc: (input) => callSessionRpc(input),
		},
		tokens: {
			create: (input) => call('tokens.create', input),
		},
		sessionFiles: {
			createDownloadUrl: (input) => call('sessionFiles.createDownloadUrl', input),
		},
		bundles: {
			list: (input) => call('bundles.list', input ?? {}),
			delete: (input) => call('bundles.delete', input),
		},
		files: {
			upload: async (file, filename) => {
				const buf = await file.arrayBuffer()
				const contentHash = await sha256Hex(buf)
				const resolvedFilename = filename ?? (file instanceof File ? file.name : 'upload.bin')
				const mimeType = file.type || 'application/octet-stream'

				// Preflight without body — server reuses an existing File when the hash already exists.
				let result = await postFile({ url: options.url, apiKey: options.apiKey, contentHash, filename: resolvedFilename, mimeType })
				if (result.status === 409 && result.body?.error === 'file-required') {
					result = await postFile({
						url: options.url,
						apiKey: options.apiKey,
						contentHash,
						filename: resolvedFilename,
						mimeType,
						body: new Blob([buf], { type: mimeType }),
					})
				}

				if (!result.body?.ok) {
					throw new RojApiError({ type: 'http_error', message: result.body?.error ?? `HTTP ${result.status}` })
				}
				return result.body as { ok: true; fileId: string; filename: string; mimeType: string; size: number; r2Key: string; deduped: boolean }
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

interface PostFileArgs {
	url: string
	apiKey: string
	contentHash: string
	filename: string
	mimeType: string
	body?: Blob
}

interface PostFileResult {
	status: number
	body: {
		ok?: boolean
		error?: string
		fileId?: string
		filename?: string
		mimeType?: string
		size?: number
		r2Key?: string
		deduped?: boolean
	} | null
}

async function postFile(args: PostFileArgs): Promise<PostFileResult> {
	const formData = new FormData()
	formData.append('contentHash', args.contentHash)
	formData.append('filename', args.filename)
	formData.append('mimeType', args.mimeType)
	if (args.body) {
		formData.append('file', args.body, args.filename)
	}
	const response = await fetch(`${args.url}/api/v1/files/upload`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${args.apiKey}` },
		body: formData,
	})
	const body = await response.json().catch(() => null) as PostFileResult['body']
	return { status: response.status, body }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', buf)
	const bytes = new Uint8Array(digest)
	let hex = ''
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, '0')
	}
	return hex
}
