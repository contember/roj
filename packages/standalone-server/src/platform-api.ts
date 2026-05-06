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

import type { LocalResource, Logger, Preset, SessionManager } from '@roj-ai/sdk'
import { SessionId } from '@roj-ai/sdk'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { Hono } from 'hono'
import type { InstanceState } from './instance.js'
import { signFileToken } from './signed-token.js'

interface Deps {
	instance: InstanceState
	sessionManager: SessionManager
	logger: Logger
	presets: Preset[]
	localResources: LocalResource[]
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

async function dispatch(
	deps: Deps,
	method: string,
	input: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; error: { type: string; message: string } }> {
	const handler = handlers[method]
	if (!handler) {
		return { ok: false, error: { type: 'method_not_found', message: `Method not supported in standalone: ${method}` } }
	}

	try {
		const value = await handler(deps, input ?? {})
		return { ok: true, value }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		deps.logger.error(`Platform RPC handler failed: ${method}`, err instanceof Error ? err : new Error(message))
		return { ok: false, error: { type: 'handler_error', message } }
	}
}

type Handler = (deps: Deps, input: any) => Promise<unknown>

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
async function startSession(
	deps: Deps,
	input: { presetId: string; initialPrompt?: string; resourceIds?: string[] },
): Promise<{ sessionId: string }> {
	const created = await deps.sessionManager.callManagerMethod('sessions.create', {
		presetId: input.presetId,
	})
	if (!created.ok) throw new Error(created.error.message)
	const { sessionId } = created.value as { sessionId: string }

	const resources = resolveSessionResources(deps, input.presetId, input.resourceIds)
	for (const resource of resources) {
		await injectLocalResource(deps, sessionId, resource)
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

	return { sessionId }
}

// Mirror roj-platform's project-init.ts:206 fallback: explicit input takes
// precedence (anything matching a local slug), otherwise fall back to the
// preset's defaultResourceSlugs. Input ids that don't match any local slug
// are warned-and-skipped — they typically come from preventado's Contember
// resource UUIDs which only exist on the real platform.
function resolveSessionResources(
	deps: Deps,
	presetId: string,
	inputResourceIds: string[] | undefined,
): LocalResource[] {
	const bySlug = new Map(deps.localResources.map(r => [r.slug, r]))

	if (inputResourceIds && inputResourceIds.length > 0) {
		const matched: LocalResource[] = []
		const unmatched: string[] = []
		for (const id of inputResourceIds) {
			const local = bySlug.get(id)
			if (local) matched.push(local)
			else unmatched.push(id)
		}
		if (unmatched.length > 0) {
			deps.logger.warn('Some input resourceIds did not match any localResources slug; ignoring', {
				unmatched,
				availableSlugs: [...bySlug.keys()],
			})
		}
		if (matched.length > 0) return matched
	}

	const preset = deps.presets.find(p => p.id === presetId)
	const slugs = preset?.defaultResourceSlugs ?? []
	const resolved: LocalResource[] = []
	const missing: string[] = []
	for (const slug of slugs) {
		const local = bySlug.get(slug)
		if (local) resolved.push(local)
		else missing.push(slug)
	}
	if (missing.length > 0) {
		deps.logger.warn(
			"Preset declares defaultResourceSlugs that aren't registered in localResources; sessions will start with an empty workspace for these slugs",
			{ presetId, missing, availableSlugs: [...bySlug.keys()] },
		)
	}
	return resolved
}

async function injectLocalResource(deps: Deps, sessionId: string, resource: LocalResource): Promise<void> {
	const fileBuffer = await readFile(resource.path)
	const filename = basename(resource.path)
	const mimeType = extname(filename).toLowerCase() === '.zip' ? 'application/zip' : 'application/octet-stream'

	const result = await deps.sessionManager.callPluginMethod(SessionId(sessionId), 'resources.inject', {
		sessionId,
		filename,
		mimeType,
		size: fileBuffer.length,
		fileBuffer,
		metadata: { slug: resource.slug, name: resource.name ?? resource.slug },
	})
	if (!result.ok) {
		deps.logger.error('Local resource injection failed', undefined, {
			sessionId,
			slug: resource.slug,
			error: result.error,
		})
		throw new Error(`Failed to inject resource '${resource.slug}': ${result.error.message ?? result.error.type}`)
	}
}

const handlers: Record<string, Handler> = {
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
		return result.value as { sessions: unknown[]; total: number }
	},

	'tokens.create': async () => ({ token: '' }),

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
