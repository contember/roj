/**
 * Platform REST API for the standalone server.
 *
 * Implements the subset of @roj-ai/client/platform method contract that
 * makes sense for a single-machine, single-instance deployment:
 *
 * - instances.*   — singleton, always returns the one instance
 * - sessions.*    — delegates to the SDK session manager
 * - tokens.create — noop (no auth)
 *
 * NOT implemented (return method_not_found):
 * - bundles.*          — presets are imported directly, not uploaded
 * - sessions.publish   — publishing requires the CF platform
 * - instances.archive  — no-op; shutdown the server instead
 */

import type { MethodInput, MethodOutput, PlatformMethodName, PlatformMethods } from '@roj-ai/client/platform'
import type { Logger, Preset, Result, Session } from '@roj-ai/sdk'
import { SessionId, sessionMetadataSchema } from '@roj-ai/sdk'
import z from 'zod/v4'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { InstanceState } from './instance.js'
import type { LocalRegistry } from './local-registry.js'
import { signFileToken } from './signed-token.js'

interface RpcError {
	type: string
	message: string
	httpStatus: number
}

interface PlatformSessionManager {
	callManagerMethod(method: string, input: unknown): Promise<Result<unknown, RpcError>>
	callPluginMethod(sessionId: SessionId, method: string, input: unknown): Promise<Result<unknown, RpcError>>
	withSessionLease(
		sessionId: SessionId,
		reason: string,
		operation: (session: Pick<Session, 'close'>) => Promise<Result<void, RpcError>>,
	): Promise<Result<void, RpcError>>
	getStats(): Promise<{
		sessions: Array<{ id: SessionId; presetId: string; status: string }>
	}>
}

interface SessionGitFs {
	addSessionWorktree(instanceId: string, sessionId: string): Promise<string>
	removeSessionWorktree(instanceId: string, sessionId: string): Promise<void>
}

interface Deps {
	instance: InstanceState
	sessionManager: PlatformSessionManager
	logger: Logger
	presets: Preset[]
	registry: LocalRegistry
	/** Per-instance bare repo + per-session worktree manager. */
	gitFs: SessionGitFs
	/** HMAC secret for signing download tokens (`sessionFiles.createDownloadUrl`). */
	tokenSecret: string
	/** Externally-reachable base URL (e.g. `http://localhost:8765`) used when minting download URLs. */
	getPublicBaseUrl(): string
}

const RpcCallSchema = z.strictObject({
	method: z.string(),
	input: z.unknown().optional(),
})

const RpcEnvelopeSchema = z.union([
	RpcCallSchema,
	z.strictObject({ batch: z.array(RpcCallSchema) }),
])

const AutoCreateSessionSchema = z.strictObject({
	presetId: z.string().min(1),
	blocking: z.boolean().optional(),
	initialPrompt: z.string().optional(),
	resourceIds: z.array(z.string()).optional(),
	fileIds: z.array(z.string()).optional(),
})

const inputSchemas = {
	'instances.create': z.strictObject({
		templateSlug: z.string(),
		bundleSlug: z.string().optional(),
		bundleRevisionId: z.string().optional(),
		name: z.string(),
		vcsType: z.enum(['github', 'gitLocal', 'none']).optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
		autoCreateSession: AutoCreateSessionSchema.optional(),
	}),
	'instances.get': z.strictObject({ instanceId: z.string() }),
	'instances.list': z.strictObject({
		limit: z.number().optional(),
		offset: z.number().optional(),
	}),
	'instances.status': z.strictObject({ instanceId: z.string() }),
	'instances.archive': z.strictObject({ instanceId: z.string() }),
	'sessions.create': z.strictObject({
		instanceId: z.string(),
		presetId: z.string().min(1),
		blocking: z.boolean().optional(),
		origin: z.string().optional(),
		expiresIn: z.number().optional(),
		initialPrompt: z.string().optional(),
	}),
	'sessions.list': z.strictObject({ instanceId: z.string() }),
	'tokens.create': z.strictObject({
		instanceId: z.string(),
		origin: z.string().optional(),
		expiresIn: z.number().optional(),
		meta: z.record(z.string(), z.unknown()).optional(),
	}),
	'resources.create': z.strictObject({
		slug: z.string(),
		name: z.string().optional(),
		description: z.string().optional(),
		fileId: z.string(),
		label: z.string().optional(),
	}),
	'resources.addRevision': z.strictObject({
		resourceId: z.string().optional(),
		resourceSlug: z.string().optional(),
		fileId: z.string(),
		label: z.string().optional(),
	}),
	'resources.get': z.strictObject({
		resourceId: z.string().optional(),
		resourceSlug: z.string().optional(),
	}),
	'resources.list': z.strictObject({
		limit: z.number().optional(),
		offset: z.number().optional(),
	}),
	'resources.delete': z.strictObject({ resourceId: z.string() }),
	'sessionFiles.createDownloadUrl': z.strictObject({
		instanceId: z.string(),
		sessionId: z.string(),
		scope: z.enum(['workspace', 'session']),
		path: z.string(),
		ttlSeconds: z.number().optional(),
	}),
} satisfies Partial<Record<PlatformMethodName, z.ZodType>>

type ImplementedMethod = keyof typeof inputSchemas

const InstanceSummaryOutputSchema = z.strictObject({
	instanceId: z.string(),
	name: z.string(),
	status: z.string(),
	templateSlug: z.string(),
	bundleSlug: z.string(),
	bundleRevisionId: z.string(),
	vcsType: z.string(),
	metadata: z.record(z.string(), z.unknown()).nullable(),
	createdAt: z.string(),
})

const SessionSummaryOutputSchema = z.strictObject({
	id: z.string(),
	presetId: z.string().nullable(),
	status: z.string(),
	createdAt: z.string(),
})

const ResourceOutputSchema = z.strictObject({
	id: z.string(),
	slug: z.string(),
	name: z.string().nullable(),
	description: z.string().nullable(),
	latestRevision: z.strictObject({
		id: z.string(),
		label: z.string().nullable(),
		file: z.strictObject({
			id: z.string(),
			filename: z.string(),
			mimeType: z.string(),
			size: z.number(),
		}),
		createdAt: z.string(),
	}).nullable(),
	createdAt: z.string(),
})

const outputSchemas = {
	'instances.create': z.strictObject({
		instanceId: z.string(),
		status: z.enum(['created', 'initializing', 'ready']),
		sessionId: z.string().optional(),
		wsToken: z.string().optional(),
	}),
	'instances.get': InstanceSummaryOutputSchema,
	'instances.list': z.strictObject({
		instances: z.array(InstanceSummaryOutputSchema),
		total: z.number(),
	}),
	'instances.status': z.strictObject({
		instanceId: z.string(),
		status: z.string(),
		sandbox: z.strictObject({
			state: z.enum(['stopped', 'starting', 'running', 'pausing', 'paused', 'failed']),
			e2bId: z.string().optional(),
			lastActivityAt: z.string().optional(),
			versions: z.strictObject({
				sdk: z.string(),
				runtime: z.strictObject({ name: z.string(), version: z.string() }).nullable(),
			}).optional(),
		}).nullable(),
		sessions: z.array(SessionSummaryOutputSchema),
		lifecycleEvents: z.array(z.strictObject({
			event: z.string(),
			detail: z.string().optional(),
			createdAt: z.string(),
		})),
		serviceUrls: z.array(z.strictObject({
			code: z.string(),
			sessionId: z.string().nullable(),
			serviceType: z.string().nullable(),
			port: z.number(),
		})),
	}),
	'instances.archive': z.strictObject({ ok: z.boolean() }),
	'sessions.create': z.strictObject({
		sessionId: z.string(),
		status: z.enum(['creating', 'active']),
		wsToken: z.string().optional(),
	}),
	'sessions.list': z.strictObject({ sessions: z.array(SessionSummaryOutputSchema) }),
	'tokens.create': z.strictObject({ token: z.string(), expiresAt: z.string() }),
	'resources.create': z.strictObject({ resourceId: z.string(), revisionId: z.string() }),
	'resources.addRevision': z.strictObject({
		revisionId: z.string(),
		noop: z.boolean().optional(),
	}),
	'resources.get': ResourceOutputSchema,
	'resources.list': z.strictObject({ resources: z.array(ResourceOutputSchema) }),
	'resources.delete': z.strictObject({ ok: z.boolean() }),
	'sessionFiles.createDownloadUrl': z.strictObject({ url: z.string(), expiresAt: z.string() }),
} satisfies { [M in ImplementedMethod]: z.ZodType<MethodOutput<PlatformMethods, M>> }

export function createPlatformApi(deps: Deps): Hono {
	const app = new Hono()

	app.post('/rpc', async (c) => {
		let rawBody: unknown
		try {
			rawBody = await c.req.json()
		} catch {
			return c.json({ ok: false, error: { type: 'invalid_request', message: 'Invalid JSON body' } }, 400)
		}
		const parsedBody = RpcEnvelopeSchema.safeParse(rawBody)
		if (!parsedBody.success) {
			return c.json({ ok: false, error: { type: 'invalid_request', message: parsedBody.error.message } }, 400)
		}
		const body = parsedBody.data

		if ('batch' in body) {
			const results = []
			for (const call of body.batch) {
				results.push(await dispatch(deps, call.method, call.input))
			}
			return c.json({ results })
		}

		const result = await dispatch(deps, body.method, body.input)
		return c.json(result)
	})

	return app
}

async function dispatch(
	deps: Deps,
	method: string,
	input: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; error: { type: string; message: string } }> {
	try {
		const value = await callHandler(deps, method, input ?? {})
		return { ok: true, value }
	} catch (err) {
		if (err instanceof UnsupportedMethodError) {
			return { ok: false, error: { type: 'method_not_found', message: err.message } }
		}
		const message = err instanceof Error ? err.message : String(err)
		deps.logger.error(`Platform RPC handler failed: ${method}`, err instanceof Error ? err : new Error(message))
		return { ok: false, error: { type: 'handler_error', message } }
	}
}

async function callHandler(deps: Deps, method: string, input: unknown): Promise<unknown> {
	switch (method) {
		case 'instances.create':
			return outputSchemas['instances.create'].parse(
				await handlers['instances.create'](deps, inputSchemas['instances.create'].parse(input)),
			)
		case 'instances.get':
			return outputSchemas['instances.get'].parse(
				await handlers['instances.get'](deps, inputSchemas['instances.get'].parse(input)),
			)
		case 'instances.list':
			return outputSchemas['instances.list'].parse(
				await handlers['instances.list'](deps, inputSchemas['instances.list'].parse(input)),
			)
		case 'instances.status':
			return outputSchemas['instances.status'].parse(
				await handlers['instances.status'](deps, inputSchemas['instances.status'].parse(input)),
			)
		case 'instances.archive':
			return outputSchemas['instances.archive'].parse(
				await handlers['instances.archive'](deps, inputSchemas['instances.archive'].parse(input)),
			)
		case 'sessions.create':
			return outputSchemas['sessions.create'].parse(
				await handlers['sessions.create'](deps, inputSchemas['sessions.create'].parse(input)),
			)
		case 'sessions.list':
			return outputSchemas['sessions.list'].parse(
				await handlers['sessions.list'](deps, inputSchemas['sessions.list'].parse(input)),
			)
		case 'tokens.create':
			return outputSchemas['tokens.create'].parse(
				await handlers['tokens.create'](deps, inputSchemas['tokens.create'].parse(input)),
			)
		case 'resources.create':
			return outputSchemas['resources.create'].parse(
				await handlers['resources.create'](deps, inputSchemas['resources.create'].parse(input)),
			)
		case 'resources.addRevision':
			return outputSchemas['resources.addRevision'].parse(
				await handlers['resources.addRevision'](deps, inputSchemas['resources.addRevision'].parse(input)),
			)
		case 'resources.get':
			return outputSchemas['resources.get'].parse(
				await handlers['resources.get'](deps, inputSchemas['resources.get'].parse(input)),
			)
		case 'resources.list':
			return outputSchemas['resources.list'].parse(
				await handlers['resources.list'](deps, inputSchemas['resources.list'].parse(input)),
			)
		case 'resources.delete':
			return outputSchemas['resources.delete'].parse(
				await handlers['resources.delete'](deps, inputSchemas['resources.delete'].parse(input)),
			)
		case 'sessionFiles.createDownloadUrl':
			return outputSchemas['sessionFiles.createDownloadUrl'].parse(
				await handlers['sessionFiles.createDownloadUrl'](
					deps,
					inputSchemas['sessionFiles.createDownloadUrl'].parse(input),
				),
			)
		default:
			throw new UnsupportedMethodError(method)
	}
}

class UnsupportedMethodError extends Error {
	constructor(readonly method: string) {
		super(`Method not supported in standalone: ${method}`)
	}
}

/**
 * A handler for one platform method, typed against the shared contract.
 *
 * `MethodInput`/`MethodOutput` come from @roj-ai/client/platform, so renaming a
 * method or reshaping its payload there is a compile error here instead of a
 * runtime `method_not_found` or a wrong-shaped JSON body. Two divergences had
 * already shipped before this was wired up.
 */
type Handler<M extends PlatformMethodName> = (
	deps: Deps,
	input: MethodInput<PlatformMethods, M>,
) => Promise<MethodOutput<PlatformMethods, M>>

type PlatformHandlers = { [M in ImplementedMethod]: Handler<M> }

// Creates a session via the SDK session manager, injects selected local files,
// then (if set) pushes `initialPrompt` as a user-chat message — order matters:
// resources must land in the workspace before the agent's first inference so
// the agent sees a non-empty workspace. Mirrors roj-platform's project-init
// (inject-resources → activatePendingSession with initialPrompt).
//
// SessionId is minted up-front (rather than letting the SDK generate one) so we
// can create the matching git worktree before the SDK initializes the session
// — the worktree path is then passed through as `workspaceDir`.
async function startSession(
	deps: Deps,
	input: { presetId: string; initialPrompt?: string; resourceIds?: string[]; fileIds?: string[] },
): Promise<{ sessionId: string; status: 'active' }> {
	const sessionId = randomUUID()
	const workspaceDir = await deps.gitFs.addSessionWorktree(deps.instance.id, sessionId)

	const created = await deps.sessionManager.callManagerMethod('sessions.create', {
		presetId: input.presetId,
		sessionId,
		workspaceDir,
	})
	if (!created.ok) {
		await removeWorktreeAfterFailure(deps, sessionId)
		throw new Error(created.error.message)
	}

	try {
		const selections = resolveSessionFiles(deps, input.presetId, input.resourceIds, input.fileIds)
		for (const selection of selections) {
			await injectRegistryFile(deps, sessionId, selection)
		}
	} catch (error) {
		await rollbackCreatedSession(deps, sessionId)
		throw error
	}

	if (input.initialPrompt) {
		const sent = await deps.sessionManager.callPluginMethod(SessionId(sessionId), 'user-chat.sendMessage', {
			content: input.initialPrompt,
		})
		if (!sent.ok) {
			deps.logger.warn('Failed to deliver initialPrompt', {
				sessionId,
				error: sent.error,
			})
		}
	}

	// Creation is synchronous here — there is no provisioning step to wait on,
	// so the session is active by the time this returns. The contract's other
	// value, 'creating', belongs to the CF platform.
	return { sessionId, status: 'active' }
}

interface ResolvedFile {
	fileId: string
	metadata?: { slug?: string; name?: string }
}

// Resolution mirrors roj-platform's project-init.ts:206:
//   1. explicit resourceIds, followed by explicit fileIds.
//   2. preset.defaultResourceSlugs only when no explicit IDs were supplied.
// Repeated selections of the same registry file are injected once.
function resolveSessionFiles(
	deps: Deps,
	presetId: string,
	inputResourceIds: string[] | undefined,
	inputFileIds: string[] | undefined,
): ResolvedFile[] {
	const hasExplicitFiles = (inputResourceIds?.length ?? 0) > 0 || (inputFileIds?.length ?? 0) > 0
	const resolved: ResolvedFile[] = []
	const seenFileIds = new Set<string>()

	if (hasExplicitFiles) {
		const unmatched: string[] = []
		for (const id of inputResourceIds ?? []) {
			const resource =
				deps.registry.getResource({ resourceId: id }) ?? deps.registry.getResource({ resourceSlug: id })
			const selection = toResolvedFile(resource)
			if (!selection) {
				unmatched.push(id)
				continue
			}
			if (seenFileIds.has(selection.fileId)) continue
			seenFileIds.add(selection.fileId)
			resolved.push(selection)
		}
		if (unmatched.length > 0) {
			deps.logger.warn('Some input resourceIds did not match the local registry; ignoring', {
				unmatched,
				availableSlugs: deps.registry.listResources().map(r => r.slug),
			})
		}
		for (const fileId of inputFileIds ?? []) {
			if (seenFileIds.has(fileId)) continue
			seenFileIds.add(fileId)
			resolved.push({ fileId })
		}
		return resolved
	}

	const preset = deps.presets.find(p => p.id === presetId)
	const slugs = preset?.defaultResourceSlugs ?? []
	const missing: string[] = []
	for (const slug of slugs) {
		const selection = toResolvedFile(deps.registry.getResource({ resourceSlug: slug }))
		if (!selection) {
			missing.push(slug)
			continue
		}
		if (seenFileIds.has(selection.fileId)) continue
		seenFileIds.add(selection.fileId)
		resolved.push(selection)
	}
	if (missing.length > 0) {
		deps.logger.warn(
			"Preset declares defaultResourceSlugs not present in the local registry; those slots will be skipped",
			{ presetId, missing, availableSlugs: deps.registry.listResources().map(r => r.slug) },
		)
	}
	return resolved
}

function toResolvedFile(resource: ReturnType<LocalRegistry['getResource']>): ResolvedFile | null {
	if (!resource || !resource.latestRevision) return null
	const file = resource.latestRevision.file
	return {
		fileId: file.id,
		metadata: { slug: resource.slug, name: resource.name ?? resource.slug },
	}
}

async function injectRegistryFile(deps: Deps, sessionId: string, selection: ResolvedFile): Promise<void> {
	const file = await deps.registry.readFileById(selection.fileId)
	if (!file) {
		if (selection.metadata?.slug) {
			throw new Error(
				`Registry file not found for resource ${selection.metadata.slug} (fileId=${selection.fileId})`,
			)
		}
		deps.logger.warn('Selected fileId did not match the local registry; ignoring', {
			fileId: selection.fileId,
		})
		return
	}

	const result = await deps.sessionManager.callPluginMethod(SessionId(sessionId), 'resources.inject', {
		sessionId,
		filename: file.meta.filename,
		mimeType: file.meta.mimeType,
		size: file.buffer.length,
		fileBuffer: file.buffer,
		metadata: selection.metadata,
	})
	if (!result.ok) {
		deps.logger.error('Registry resource injection failed', undefined, {
			sessionId,
			fileId: selection.fileId,
			error: result.error,
		})
		throw new Error(`Failed to inject registry file '${selection.fileId}': ${result.error.message}`)
	}
}

async function rollbackCreatedSession(deps: Deps, sessionId: string): Promise<void> {
	let closeAttempted = false
	try {
		const closeResult = await deps.sessionManager.withSessionLease(
			SessionId(sessionId),
			'standalone:rollback',
			async (session) => {
				closeAttempted = true
				return session.close()
			},
		)
		if (!closeResult.ok) {
			deps.logger.error(
				closeAttempted ? 'Failed to close session during rollback' : 'Failed to load session for rollback',
				undefined,
				{ sessionId, error: closeResult.error },
			)
		}
	} catch (error) {
		deps.logger.error(
			closeAttempted ? 'Failed to close session during rollback' : 'Failed to load session for rollback',
			error instanceof Error ? error : new Error(String(error)),
			{ sessionId },
		)
	}

	await removeWorktreeAfterFailure(deps, sessionId)
}

async function removeWorktreeAfterFailure(deps: Deps, sessionId: string): Promise<void> {
	try {
		await deps.gitFs.removeSessionWorktree(deps.instance.id, sessionId)
	} catch (error) {
		deps.logger.error(
			'Failed to remove session worktree during rollback',
			error instanceof Error ? error : new Error(String(error)),
			{ sessionId },
		)
	}
}

const handlers: PlatformHandlers = {
	'instances.create': async (deps, input) => {
		if (input.metadata !== undefined) {
			deps.instance.metadata = input.metadata
		}

		let sessionId: string | undefined
		if (input.autoCreateSession?.presetId) {
			const result = await startSession(deps, {
				presetId: input.autoCreateSession.presetId,
				initialPrompt: input.autoCreateSession.initialPrompt,
				resourceIds: input.autoCreateSession.resourceIds,
				fileIds: input.autoCreateSession.fileIds,
			})
			sessionId = result.sessionId
		}

		return {
			instanceId: deps.instance.id,
			status: 'ready',
			...(sessionId ? { sessionId } : {}),
		}
	},

	'instances.list': async ({ instance }) => ({
		instances: [instanceSummary(instance)],
		total: 1,
	}),

	'instances.get': async ({ instance }, _input) => instanceSummary(instance),

	'instances.status': async ({ instance, sessionManager }) => {
		const stats = await sessionManager.getStats()
		return {
			instanceId: instance.id,
			status: 'ready',
			sandbox: { state: 'running' },
			sessions: stats.sessions.map(s => ({
				id: s.id,
				presetId: s.presetId,
				status: s.status,
				createdAt: new Date().toISOString(),
			})),
			lifecycleEvents: [],
			serviceUrls: [],
		}
	},

	'instances.archive': async () => ({ ok: true }),

	'sessions.create': async (deps, input) => startSession(deps, input),

	'sessions.list': async ({ sessionManager }) => {
		const result = await sessionManager.callManagerMethod('sessions.list', {})
		if (!result.ok) throw new Error(result.error.message)
		// callManagerMethod is typed Result<unknown>, so the plugin's output schema
		// does not reach us — validate here rather than assert.
		const listed = z.object({ sessions: z.array(sessionMetadataSchema) }).parse(result.value)
		return {
			sessions: listed.sessions.map(s => ({
				id: String(s.sessionId),
				presetId: s.presetId,
				status: s.status,
				createdAt: new Date(s.createdAt).toISOString(),
			})),
		}
	},

	// Standalone has no auth: the token is empty and never checked. expiresAt is
	// still part of the contract, so hand back a real timestamp rather than
	// omitting the field and hoping no caller reads it.
	'tokens.create': async () => ({ token: '', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),

	'resources.create': async (deps, input) => deps.registry.createResource(input),

	'resources.addRevision': async (deps, input) => deps.registry.addRevision(input),

	'resources.get': async (deps, input) => {
		const resource = deps.registry.getResource(input)
		if (!resource) throw new Error('Resource not found')
		return resource
	},

	'resources.list': async (deps, _input) => ({
		resources: deps.registry.listResources(),
	}),

	'resources.delete': async (deps, input) => deps.registry.deleteResource(input.resourceId),

	'sessionFiles.createDownloadUrl': async (deps, input) => {
		if (input.scope !== 'workspace' && input.scope !== 'session') {
			throw new Error(`Invalid scope: ${input.scope}`)
		}
		if (!input.path || input.path.includes('..')) {
			throw new Error('Path traversal not allowed')
		}

		const ttl = Math.min(Math.max(input.ttlSeconds ?? 300, 1), 3600)
		const expiresAt = Date.now() + ttl * 1000

		const token = signFileToken(deps.tokenSecret, {
			instanceId: input.instanceId,
			sessionId: input.sessionId,
			scope: input.scope,
			path: input.path,
			expiresAt,
		})

		const encodedPath = input.path
			.split('/')
			.map(seg => encodeURIComponent(seg))
			.join('/')
		const url = `${deps.getPublicBaseUrl()}/api/v1/instances/${input.instanceId}/sessions/${input.sessionId}/files/${input.scope}/${encodedPath}?token=${encodeURIComponent(token)}`

		return { url, expiresAt: new Date(expiresAt).toISOString() }
	},
}

function instanceSummary(instance: InstanceState) {
	return {
		instanceId: instance.id,
		name: instance.name,
		status: 'ready',
		templateSlug: 'standalone',
		bundleSlug: 'standalone',
		bundleRevisionId: '',
		vcsType: 'none',
		metadata: instance.metadata,
		createdAt: instance.createdAt,
	}
}
