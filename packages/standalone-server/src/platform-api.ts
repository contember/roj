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

import { platformMethods } from '@roj-ai/client/platform'
import type { MethodInput, MethodOutput, PlatformMethodName, PlatformMethods } from '@roj-ai/client/platform'
import type { Logger, Preset, SessionManager } from '@roj-ai/sdk'
import { SessionId, sessionMetadataSchema } from '@roj-ai/sdk'
import z from 'zod/v4'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { GitInstanceFs } from './git-instance-fs.js'
import type { InstanceState } from './instance.js'
import type { LocalRegistry } from './local-registry.js'
import { signFileToken } from './signed-token.js'

interface Deps {
	instance: InstanceState
	sessionManager: SessionManager
	logger: Logger
	presets: Preset[]
	registry: LocalRegistry
	/** Per-instance bare repo + per-session worktree manager. */
	gitFs: GitInstanceFs
	/** HMAC secret for signing download tokens (`sessionFiles.createDownloadUrl`). */
	tokenSecret: string
	/** Externally-reachable base URL (e.g. `http://localhost:8765`) used when minting download URLs. */
	publicBaseUrl: string
}

interface RpcEnvelope {
	method?: string
	input?: unknown
	batch?: Array<{ method: string; input?: unknown }>
}

export function createPlatformApi(deps: Deps): Hono {
	const app = new Hono()

	app.post('/rpc', async (c) => {
		const body = await c.req.json<RpcEnvelope>().catch(() => ({} as RpcEnvelope))

		if (Array.isArray(body.batch)) {
			const results = []
			for (const call of body.batch) {
				results.push(await dispatch(deps, call.method, call.input))
			}
			return c.json({ results })
		}

		if (typeof body.method !== 'string') {
			return c.json({ ok: false, error: { type: 'invalid_request', message: 'Missing method' } }, 400)
		}

		const result = await dispatch(deps, body.method, body.input)
		return c.json(result)
	})

	return app
}

const isPlatformMethod = (method: string): method is PlatformMethodName =>
	Object.hasOwn(platformMethods, method)

async function dispatch(
	deps: Deps,
	method: string,
	input: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; error: { type: string; message: string } }> {
	const handler = isPlatformMethod(method) ? handlers[method] : undefined
	if (!handler) {
		return { ok: false, error: { type: 'method_not_found', message: `Method not supported in standalone: ${method}` } }
	}

	try {
		// The map is keyed by method, so each handler's input type is its own; the
		// envelope carries an unvalidated body, which is exactly what the contract
		// types describe.
		const value = await (handler as (deps: Deps, input: unknown) => Promise<unknown>)(deps, input ?? {})
		return { ok: true, value }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		deps.logger.error(`Platform RPC handler failed: ${method}`, err instanceof Error ? err : new Error(message))
		return { ok: false, error: { type: 'handler_error', message } }
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

/**
 * Partial on purpose: bundles.*, sessions.publish, sessions.usage,
 * instances.archive and services.getUrl are deliberately unimplemented here and
 * fall through to `method_not_found`. Partial makes that an explicit gap rather
 * than a silent one, while still checking every method that IS implemented.
 */
type PlatformHandlers = Partial<{ [M in PlatformMethodName]: Handler<M> }>

interface AutoCreateSessionInput {
	presetId: string
	initialPrompt?: string
	resourceIds?: string[]
	fileIds?: string[]
	blocking?: boolean
}

// Shared by `instances.create.autoCreateSession` and `sessions.create`. Creates
// a session via the SDK session manager, injects any matching local resources,
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
	input: { presetId: string; initialPrompt?: string; resourceIds?: string[] },
): Promise<{ sessionId: string; status: 'active' }> {
	const sessionId = randomUUID()
	const workspaceDir = await deps.gitFs.addSessionWorktree(deps.instance.id, sessionId)

	const created = await deps.sessionManager.callManagerMethod('sessions.create', {
		presetId: input.presetId,
		sessionId,
		workspaceDir,
	})
	if (!created.ok) {
		// Roll back the worktree we just created so a retry isn't blocked by an
		// orphaned dir. Best-effort — failure here is logged inside removeSessionWorktree.
		await deps.gitFs.removeSessionWorktree(deps.instance.id, sessionId)
		throw new Error(created.error.message)
	}

	const resources = resolveSessionResources(deps, input.presetId, input.resourceIds)
	for (const resource of resources) {
		await injectRegistryResource(deps, sessionId, resource)
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

interface ResolvedResource {
	resourceId: string
	slug: string
	name: string | null
	fileId: string
	filename: string
	mimeType: string
}

// Resolution mirrors roj-platform's project-init.ts:206:
//   1. explicit input.resourceIds — matched against the local registry by ID
//      first, then by slug (since local-dev callers often pass slugs as ids).
//   2. fallback to preset.defaultResourceSlugs (looked up by slug).
function resolveSessionResources(
	deps: Deps,
	presetId: string,
	inputResourceIds: string[] | undefined,
): ResolvedResource[] {
	if (inputResourceIds && inputResourceIds.length > 0) {
		const matched: ResolvedResource[] = []
		const unmatched: string[] = []
		for (const id of inputResourceIds) {
			const resource =
				deps.registry.getResource({ resourceId: id }) ?? deps.registry.getResource({ resourceSlug: id })
			const resolved = toResolvedResource(resource)
			if (resolved) matched.push(resolved)
			else unmatched.push(id)
		}
		if (unmatched.length > 0) {
			deps.logger.warn('Some input resourceIds did not match the local registry; ignoring', {
				unmatched,
				availableSlugs: deps.registry.listResources().map(r => r.slug),
			})
		}
		if (matched.length > 0) return matched
	}

	const preset = deps.presets.find(p => p.id === presetId)
	const slugs = preset?.defaultResourceSlugs ?? []
	const resolved: ResolvedResource[] = []
	const missing: string[] = []
	for (const slug of slugs) {
		const r = toResolvedResource(deps.registry.getResource({ resourceSlug: slug }))
		if (r) resolved.push(r)
		else missing.push(slug)
	}
	if (missing.length > 0) {
		deps.logger.warn(
			"Preset declares defaultResourceSlugs not present in the local registry; those slots will be skipped",
			{ presetId, missing, availableSlugs: deps.registry.listResources().map(r => r.slug) },
		)
	}
	return resolved
}

function toResolvedResource(resource: ReturnType<LocalRegistry['getResource']>): ResolvedResource | null {
	if (!resource || !resource.latestRevision) return null
	const file = resource.latestRevision.file
	return {
		resourceId: resource.id,
		slug: resource.slug,
		name: resource.name,
		fileId: file.id,
		filename: file.filename,
		mimeType: file.mimeType,
	}
}

async function injectRegistryResource(deps: Deps, sessionId: string, resource: ResolvedResource): Promise<void> {
	const file = await deps.registry.readFileById(resource.fileId)
	if (!file) {
		throw new Error(`Registry file not found for resource ${resource.slug} (fileId=${resource.fileId})`)
	}

	const result = await deps.sessionManager.callPluginMethod(SessionId(sessionId), 'resources.inject', {
		sessionId,
		filename: resource.filename,
		mimeType: resource.mimeType,
		size: file.buffer.length,
		fileBuffer: file.buffer,
		metadata: { slug: resource.slug, name: resource.name ?? resource.slug },
	})
	if (!result.ok) {
		deps.logger.error('Registry resource injection failed', undefined, {
			sessionId,
			slug: resource.slug,
			error: result.error,
		})
		throw new Error(`Failed to inject resource '${resource.slug}': ${result.error.message ?? result.error.type}`)
	}
}

const handlers: PlatformHandlers = {
	'instances.create': async (
		deps,
		input: { metadata?: Record<string, unknown>; autoCreateSession?: AutoCreateSessionInput },
	) => {
		if (input.metadata !== undefined) {
			deps.instance.metadata = input.metadata
		}

		let sessionId: string | undefined
		if (input.autoCreateSession?.presetId) {
			const result = await startSession(deps, {
				presetId: input.autoCreateSession.presetId,
				initialPrompt: input.autoCreateSession.initialPrompt,
				resourceIds: input.autoCreateSession.resourceIds,
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

	'sessions.create': async (
		deps,
		input: { presetId: string; initialPrompt?: string; resourceIds?: string[] },
	) => startSession(deps, input),

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

	'resources.create': async (
		deps,
		input: { slug: string; name?: string; description?: string; fileId: string; label?: string },
	) => deps.registry.createResource(input),

	'resources.addRevision': async (
		deps,
		input: { resourceId?: string; resourceSlug?: string; fileId: string; label?: string },
	) => deps.registry.addRevision(input),

	'resources.get': async (deps, input: { resourceId?: string; resourceSlug?: string }) => {
		const resource = deps.registry.getResource(input)
		if (!resource) throw new Error('Resource not found')
		return resource
	},

	'resources.list': async (deps, _input: { limit?: number; offset?: number }) => ({
		resources: deps.registry.listResources(),
	}),

	'resources.delete': async (deps, input: { resourceId: string }) => deps.registry.deleteResource(input.resourceId),

	'sessionFiles.createDownloadUrl': async (
		deps,
		input: {
			instanceId: string
			sessionId: string
			scope: 'workspace' | 'session'
			path: string
			ttlSeconds?: number
		},
	) => {
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
		const url = `${deps.publicBaseUrl}/api/v1/instances/${input.instanceId}/sessions/${input.sessionId}/files/${input.scope}/${encodedPath}?token=${encodeURIComponent(token)}`

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
