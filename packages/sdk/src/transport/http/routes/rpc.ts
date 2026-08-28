/**
 * RPC Routes — Generic Dispatcher
 *
 * Single POST /rpc endpoint that auto-routes to plugin methods.
 * No hardcoded handlers — all business logic lives in plugins.
 *
 * Supports both single calls and batch calls:
 * - Single: { method, input } → { ok: true, value } | { ok: false, error }
 * - Batch:  { batch: [{ method, input }, ...] } → { results: [{ ok: true, value } | { ok: false, error }, ...] }
 *
 * A batch is all-settled: every item runs and gets its own envelope, so `results`
 * always has the length of `batch`. A shorter array would leave the caller unable
 * to tell a completed batch from a truncated one — and because running every item
 * makes the batch length the work one request buys, the length is capped.
 *
 * Routing order:
 * 1. Manager methods (session creation, listing, etc.)
 * 2. Session plugin methods (require sessionId in input)
 * 3. 404 if not found
 */

import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { AgentId } from '~/core/agents/schema.js'
import type { DomainError } from '~/core/errors.js'
import { type CallerContext, DEFAULT_CALLER } from '~/core/plugins/plugin-builder.js'
import { parseSessionId } from '~/core/sessions/schema.js'
import type { SessionManager } from '~/core/sessions/session-manager.js'
import { getServices } from '../context.js'
import type { AppEnv } from '../context.js'

type MethodResult =
	| { ok: true; value: unknown }
	| { ok: false; error: { type: string; message: string } }

function formatError(error: DomainError): { ok: false; error: { type: string; message: string } } {
	return { ok: false, error: { type: error.type, message: error.message } }
}

/**
 * Dispatch a single RPC method call and return the result envelope.
 */
async function dispatchMethod(
	sessionRuntime: SessionManager,
	method: string,
	input: unknown,
): Promise<{ httpStatus: ContentfulStatusCode; body: MethodResult }> {
	// 1. Try manager methods (session lifecycle, presets)
	const managerMethods = sessionRuntime.getManagerMethods()
	if (managerMethods.has(method)) {
		const result = await sessionRuntime.callManagerMethod(method, input)

		if (!result.ok) {
			return { httpStatus: 200, body: formatError(result.error) }
		}

		return { httpStatus: 200, body: { ok: true, value: result.value } }
	}

	// 2. Try session plugin methods (require sessionId in input)
	if (typeof input === 'object' && input !== null && 'sessionId' in input && typeof input.sessionId === 'string') {
		// Checked before the lease: acquiring one loads the session, which joins the id into a path.
		const sessionIdResult = parseSessionId(input.sessionId)
		if (!sessionIdResult.ok) {
			return { httpStatus: 400, body: formatError(sessionIdResult.error) }
		}
		const sessionId = sessionIdResult.value
		const agentId = 'agentId' in input && typeof input.agentId === 'string' ? AgentId(input.agentId) : undefined

		// Extract caller context injected by worker, strip from input
		const caller: CallerContext = '_caller' in input && typeof input._caller === 'object' && input._caller !== null
			? input._caller as CallerContext
			: DEFAULT_CALLER
		const { _caller: _, ...cleanInput } = input as Record<string, unknown>

		const sessionResult = await sessionRuntime.acquireSessionLease(sessionId, `http:rpc:${method}`)
		if (sessionResult.ok) {
			try {
				const pluginMethods = sessionResult.value.session.getPluginMethods()

				if (pluginMethods.has(method)) {
					const result = await sessionRuntime.callPluginMethod(sessionId, method, cleanInput, agentId, caller)

					if (!result.ok) {
						return { httpStatus: 200, body: formatError(result.error) }
					}

					return { httpStatus: 200, body: { ok: true, value: result.value } }
				}
			} finally {
				sessionResult.value.release()
			}
		} else if (sessionResult.error.type === 'session_not_found') {
			return { httpStatus: 200, body: formatError(sessionResult.error) }
		}
	}

	// 3. Method not found — transport error, use 400
	return { httpStatus: 400, body: { ok: false, error: { type: 'method_not_found', message: `Unknown method: ${method}` } } }
}

/** Every item runs, so one request buys this much dispatch and no more. */
const MAX_BATCH_ITEMS = 100

interface BatchRequest {
	batch: unknown[]
}

interface BatchCall {
	method: string
	input?: unknown
}

/** Items stay `unknown` until here — `{"batch":[null]}` used to reach `call.method` and 500. */
function isBatchCall(value: unknown): value is BatchCall {
	return typeof value === 'object' && value !== null && 'method' in value && typeof value.method === 'string'
		&& value.method !== ''
}

function isBatchRequest(body: unknown): body is BatchRequest {
	return typeof body === 'object' && body !== null && 'batch' in body && Array.isArray(body.batch)
}

/**
 * Creates the RPC routes.
 */
export function createRpcRoutes(): Hono<AppEnv> {
	const app = new Hono<AppEnv>()

	app.post('/', async (c) => {
		let body: unknown

		try {
			body = await c.req.json()
		} catch {
			return c.json(
				{ ok: false, error: { type: 'invalid_json', message: 'Invalid JSON in request body' } },
				400,
			)
		}

		const { sessionRuntime, logger } = getServices(c)

		// Batch request. The status describes the envelope, never an item: the body is
		// `{results}` with no top-level `error`, so a non-2xx here reads as a transport
		// failure and hides the per-item error the client would otherwise surface.
		if (isBatchRequest(body)) {
			if (body.batch.length > MAX_BATCH_ITEMS) {
				return c.json(
					{ ok: false, error: { type: 'batch_too_large', message: `Batch holds more than ${MAX_BATCH_ITEMS} calls` } },
					400,
				)
			}

			const results: MethodResult[] = []

			for (const call of body.batch) {
				if (!isBatchCall(call)) {
					results.push({ ok: false, error: { type: 'missing_method', message: "Missing 'method' field in batch call" } })
					continue
				}

				try {
					results.push((await dispatchMethod(sessionRuntime, call.method, call.input)).body)
				} catch (error) {
					logger.error('Batch RPC call failed', error instanceof Error ? error : new Error(String(error)), {
						method: call.method,
					})
					results.push({ ok: false, error: { type: 'internal_error', message: 'Internal server error' } })
				}
			}

			return c.json({ results })
		}

		// Single request — extract method from body via narrowing
		const method = typeof body === 'object' && body !== null && 'method' in body ? body.method : undefined
		const input = typeof body === 'object' && body !== null && 'input' in body ? body.input : undefined

		if (!method || typeof method !== 'string') {
			return c.json(
				{ ok: false, error: { type: 'missing_method', message: "Missing 'method' field in request" } },
				400,
			)
		}

		const { httpStatus, body: resultBody } = await dispatchMethod(sessionRuntime, method, input)
		return c.json(resultBody, httpStatus)
	})

	return app
}
