/**
 * RPC Integration Tests
 *
 * Tests for the RPC dispatch system using TestHarness + Hono.
 * Covers batch calls, method dispatch, error handling.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { bootstrapForTesting } from '../../../testing/bootstrap-for-testing.js'
import type { AppEnv } from '../app.js'
import { createRpcRoutes } from './rpc.js'

interface RpcResponse<T = unknown> {
	ok: boolean
	value?: T
	error?: { type: string; message: string }
}

interface BatchResponse {
	results: RpcResponse[]
}

async function rpcCall(app: Hono<AppEnv>, method: string, input?: unknown): Promise<Response> {
	return app.request('/rpc', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ method, input }),
	})
}

async function rpcBatch(app: Hono<AppEnv>, calls: Array<{ method: string; input?: unknown }>): Promise<Response> {
	return app.request('/rpc', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ batch: calls }),
	})
}

describe('RPC integration', () => {
	let app: Hono<AppEnv>
	let harness: TestHarness

	beforeEach(() => {
		harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		})

		const baseServices = bootstrapForTesting(undefined, [createTestPreset()])

		app = new Hono<AppEnv>()
		app.use('*', async (c, next) => {
			c.set('services', {
				...baseServices,
				sessionRuntime: harness.sessionManager,
			})
			await next()
		})
		app.route('/rpc', createRpcRoutes())
	})

	// =========================================================================
	// Batch RPC calls
	// =========================================================================

	describe('batch RPC calls', () => {
		it('batch calls → all executed, results returned in order', async () => {
			// First create a session
			const createRes = await rpcCall(app, 'sessions.create', { presetId: 'test' })
			const createJson: RpcResponse<{ sessionId: string }> = JSON.parse(await createRes.text())
			expect(createJson.ok).toBe(true)
			const sessionId = createJson.value!.sessionId

			// Batch: get session + list presets
			const res = await rpcBatch(app, [
				{ method: 'sessions.get', input: { sessionId } },
				{ method: 'presets.list', input: {} },
			])

			expect(res.status).toBe(200)
			const json: BatchResponse = JSON.parse(await res.text())
			expect(json.results).toHaveLength(2)

			// First result: sessions.get
			expect(json.results[0].ok).toBe(true)
			expect(json.results[0].value).toHaveProperty('sessionId', sessionId)

			// Second result: presets.list
			expect(json.results[1].ok).toBe(true)
			expect(json.results[1].value).toHaveProperty('presets', expect.any(Array))
		})

		it('batch stops on first error', async () => {
			const res = await rpcBatch(app, [
				{ method: 'sessions.create', input: { presetId: 'test' } },
				{ method: 'sessions.get', input: { sessionId: 'nonexistent' } },
				{ method: 'presets.list', input: {} },
			])

			expect(res.status).toBe(200)
			const json: BatchResponse = JSON.parse(await res.text())

			// First result succeeds
			expect(json.results[0].ok).toBe(true)

			// Second result fails (session not found)
			expect(json.results[1].ok).toBe(false)
			expect(json.results[1].error!.type).toBe('session_not_found')

			// Third result should not be present (batch stops on first error)
			expect(json.results).toHaveLength(2)
		})
	})

	// =========================================================================
	// Manager method dispatch
	// =========================================================================

	describe('manager method dispatch', () => {
		it('sessions.create dispatches correctly', async () => {
			const res = await rpcCall(app, 'sessions.create', { presetId: 'test' })

			expect(res.status).toBe(200)
			const json: RpcResponse<{ sessionId: string }> = JSON.parse(await res.text())
			expect(json.ok).toBe(true)
			expect(json.value!.sessionId).toBeDefined()
		})

		it('sessions.list dispatches correctly', async () => {
			// Create a session first
			await rpcCall(app, 'sessions.create', { presetId: 'test' })

			const res = await rpcCall(app, 'sessions.list', {})

			expect(res.status).toBe(200)
			const json: RpcResponse<{ sessions: unknown[]; total: number }> = JSON.parse(await res.text())
			expect(json.ok).toBe(true)
			expect(json.value!.total).toBeGreaterThanOrEqual(1)
		})

		it('presets.list dispatches correctly', async () => {
			const res = await rpcCall(app, 'presets.list', {})

			expect(res.status).toBe(200)
			const json: RpcResponse<{ presets: Array<{ id: string; name: string }> }> = JSON.parse(await res.text())
			expect(json.ok).toBe(true)
			expect(json.value!.presets).toBeInstanceOf(Array)
			expect(json.value!.presets.some(p => p.id === 'test')).toBe(true)
		})
	})

	// =========================================================================
	// Session method dispatch
	// =========================================================================

	describe('session method dispatch', () => {
		it('sessions.get dispatches correctly', async () => {
			const createRes = await rpcCall(app, 'sessions.create', { presetId: 'test' })
			const createJson: RpcResponse<{ sessionId: string }> = JSON.parse(await createRes.text())
			const sessionId = createJson.value!.sessionId

			const res = await rpcCall(app, 'sessions.get', { sessionId })

			expect(res.status).toBe(200)
			const json: RpcResponse<{ sessionId: string; presetId: string; status: string }> = JSON.parse(await res.text())
			expect(json.ok).toBe(true)
			expect(json.value!.sessionId).toBe(sessionId)
			expect(json.value!.presetId).toBe('test')
			expect(json.value!.status).toBe('active')
		})

		it('sessions.close dispatches correctly', async () => {
			const createRes = await rpcCall(app, 'sessions.create', { presetId: 'test' })
			const createJson: RpcResponse<{ sessionId: string }> = JSON.parse(await createRes.text())
			const sessionId = createJson.value!.sessionId

			const res = await rpcCall(app, 'sessions.close', { sessionId })

			expect(res.status).toBe(200)
			const json: RpcResponse = JSON.parse(await res.text())
			expect(json.ok).toBe(true)

			// Verify session is closed
			const getRes = await rpcCall(app, 'sessions.get', { sessionId })
			const getJson: RpcResponse<{ status: string }> = JSON.parse(await getRes.text())
			expect(getJson.ok).toBe(true)
			expect(getJson.value!.status).toBe('closed')
		})

		it('user-chat.sendMessage dispatches correctly', async () => {
			const createRes = await rpcCall(app, 'sessions.create', { presetId: 'test' })
			const createJson: RpcResponse<{ sessionId: string }> = JSON.parse(await createRes.text())
			const sessionId = createJson.value!.sessionId

			// Get entry agent
			const getRes = await rpcCall(app, 'sessions.get', { sessionId })
			const getJson: RpcResponse<{ entryAgentId: string }> = JSON.parse(await getRes.text())
			const agentId = getJson.value!.entryAgentId

			const res = await rpcCall(app, 'user-chat.sendMessage', { sessionId, agentId, content: 'Hello via RPC' })

			expect(res.status).toBe(200)
			const json: RpcResponse<{ messageId: string }> = JSON.parse(await res.text())
			expect(json.ok).toBe(true)
			expect(json.value!.messageId).toBeDefined()
		})
	})

	// =========================================================================
	// Error handling
	// =========================================================================

	describe('error handling', () => {
		it('method not found → error with type method_not_found', async () => {
			const res = await rpcCall(app, 'nonexistent.method', {})

			expect(res.status).toBe(400)
			const json: RpcResponse = JSON.parse(await res.text())
			expect(json.ok).toBe(false)
			expect(json.error!.type).toBe('method_not_found')
		})

		it('input validation error → error with type validation_error', async () => {
			const res = await rpcCall(app, 'sessions.list', { limit: 'not_a_number' })

			expect(res.status).toBe(200)
			const json: RpcResponse = JSON.parse(await res.text())
			expect(json.ok).toBe(false)
			expect(json.error!.type).toBe('validation_error')
		})

		it('session not found → error with type session_not_found', async () => {
			const res = await rpcCall(app, 'sessions.get', { sessionId: 'nonexistent-session-id' })

			expect(res.status).toBe(200)
			const json: RpcResponse = JSON.parse(await res.text())
			expect(json.ok).toBe(false)
			expect(json.error!.type).toBe('session_not_found')
		})
	})
})
