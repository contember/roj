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

import type { Logger, SessionManager } from '@roj-ai/sdk'
import { Hono } from 'hono'
import type { InstanceState } from './instance.js'

interface Deps {
	instance: InstanceState
	sessionManager: SessionManager
	logger: Logger
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

const handlers: Record<string, Handler> = {
	'instances.create': async ({ instance }) => ({
		instanceId: instance.id,
		status: 'ready',
	}),

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

	'sessions.create': async ({ sessionManager }, input: { presetId: string; initialPrompt?: string }) => {
		const result = await sessionManager.callManagerMethod('sessions.create', {
			presetId: input.presetId,
		})
		if (!result.ok) throw new Error(result.error.message)
		return result.value as { sessionId: string }
	},

	'sessions.list': async ({ sessionManager }) => {
		const result = await sessionManager.callManagerMethod('sessions.list', {})
		if (!result.ok) throw new Error(result.error.message)
		return result.value as { sessions: unknown[]; total: number }
	},

	'tokens.create': async () => ({ token: '' }),
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
		metadata: null,
		createdAt: instance.createdAt,
	}
}
