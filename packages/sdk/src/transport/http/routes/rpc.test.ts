/**
 * RPC Routes Tests
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { ModelId } from '~/core/llm/schema.js'
import type { Preset } from '~/core/preset/index.js'
import { createSessionManager } from '../../../bootstrap.js'
import { bootstrapForTesting } from '../../../testing/bootstrap-for-testing.js'
import type { AppEnv, AppServices } from '../app.js'
import { createRpcRoutes } from './rpc.js'

/** Minimal preset for testing */
const echoTestPreset: Preset = {
	id: 'echo-test',
	name: 'Echo Test',
	orchestrator: {
		system: 'Test',
		tools: [],
		agents: ['echo'],
		model: ModelId('mock'),
	},
	agents: [{
		name: 'echo',
		system: 'Echo',
		tools: [],
		agents: [],
		model: ModelId('mock'),
	}],
}

// Helper type for RPC responses (new { ok, value/error } format)
interface RpcOkResponse<T> {
	ok: true
	value: T
}

interface RpcErrResponse {
	ok: false
	error: { type: string; message: string }
}

type RpcResponse<T> = RpcOkResponse<T> | RpcErrResponse

// Helper to parse JSON response with proper typing
async function parseJson<T>(res: Response): Promise<RpcResponse<T>> {
	return res.json() as Promise<RpcResponse<T>>
}

describe('RPC Routes', () => {
	let app: Hono<AppEnv>
	let services: AppServices

	beforeEach(() => {
		const baseServices = bootstrapForTesting(undefined, [echoTestPreset])

		const sessionManager = createSessionManager(baseServices)

		services = {
			...baseServices,
			sessionRuntime: sessionManager,
		}

		// Create Hono app with RPC routes
		app = new Hono<AppEnv>()
		app.use('*', async (c, next) => {
			c.set('services', services)
			await next()
		})
		app.route('/rpc', createRpcRoutes())
	})

	describe('Request validation', () => {
		it('should return error for invalid JSON', async () => {
			const res = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: 'invalid json',
			})

			expect(res.status).toBe(400)
			const json = await parseJson<never>(res)
			expect(json.ok).toBe(false)
			expect(!json.ok && json.error.type).toBe('invalid_json')
		})

		it('should return error for missing method', async () => {
			const res = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ input: {} }),
			})

			expect(res.status).toBe(400)
			const json = await parseJson<never>(res)
			expect(json.ok).toBe(false)
			expect(!json.ok && json.error.type).toBe('missing_method')
		})

		it('should return error for unknown method', async () => {
			const res = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ method: 'unknown.method', input: {} }),
			})

			expect(res.status).toBe(400)
			const json = await parseJson<never>(res)
			expect(json.ok).toBe(false)
			expect(!json.ok && json.error.type).toBe('method_not_found')
		})

		it('should return validation error for invalid input', async () => {
			const res = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'sessions.list',
					input: { limit: 'not a number' },
				}),
			})

			expect(res.status).toBe(200)
			const json = await parseJson<never>(res)
			expect(json.ok).toBe(false)
			expect(!json.ok && json.error.type).toBe('validation_error')
		})
	})

	describe('sessions.list', () => {
		it('should return empty list initially', async () => {
			const res = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ method: 'sessions.list', input: {} }),
			})

			expect(res.status).toBe(200)
			const json = await parseJson<{ sessions: unknown[]; total: number }>(res)
			expect(json.ok).toBe(true)
			expect(json.ok && json.value.sessions).toEqual([])
			expect(json.ok && json.value.total).toBe(0)
		})
	})

	describe('sessions.create', () => {
		it('should create a session', async () => {
			const res = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'sessions.create',
					input: { presetId: 'echo-test' },
				}),
			})

			expect(res.status).toBe(200)
			const json = await parseJson<{ sessionId: string }>(res)
			expect(json.ok).toBe(true)
			expect(json.ok && json.value.sessionId).toBeDefined()
			expect(json.ok && typeof json.value.sessionId).toBe('string')
		})

		it('should return error for unknown preset', async () => {
			const res = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'sessions.create',
					input: { presetId: 'unknown-preset' },
				}),
			})

			expect(res.status).toBe(200)
			const json = await parseJson<never>(res)
			expect(json.ok).toBe(false)
			expect(!json.ok && json.error.type).toBe('preset_not_found')
		})
	})

	describe('sessions.get', () => {
		it('should get session info', async () => {
			// Create session first
			const createRes = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'sessions.create',
					input: { presetId: 'echo-test' },
				}),
			})
			const createJson = await parseJson<{ sessionId: string }>(createRes)
			const sessionId = createJson.ok ? createJson.value.sessionId : ''

			// Get session
			const res = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'sessions.get',
					input: { sessionId },
				}),
			})

			expect(res.status).toBe(200)
			const json = await parseJson<{ sessionId: string; presetId: string; status: string }>(res)
			expect(json.ok).toBe(true)
			expect(json.ok && json.value.sessionId).toBe(sessionId)
			expect(json.ok && json.value.presetId).toBe('echo-test')
			expect(json.ok && json.value.status).toBe('active')
		})

		it('should return error for unknown session', async () => {
			const res = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'sessions.get',
					input: { sessionId: 'nonexistent-session' },
				}),
			})

			expect(res.status).toBe(200)
			const json = await parseJson<never>(res)
			expect(json.ok).toBe(false)
			expect(!json.ok && json.error.type).toBe('session_not_found')
		})
	})

	describe('user-chat.sendMessage', () => {
		it('should send a message', async () => {
			// Create session first
			const createRes = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'sessions.create',
					input: { presetId: 'echo-test' },
				}),
			})
			const createJson = await parseJson<{ sessionId: string }>(createRes)
			const sessionId = createJson.ok ? createJson.value.sessionId : ''

			// Get session to find entry agent ID
			const getRes = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'sessions.get',
					input: { sessionId },
				}),
			})
			const getJson = await parseJson<{ entryAgentId: string }>(getRes)
			const agentId = getJson.ok ? getJson.value.entryAgentId : ''

			// Send message
			const res = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'user-chat.sendMessage',
					input: { sessionId, agentId, content: 'Hello' },
				}),
			})

			expect(res.status).toBe(200)
			const json = await parseJson<{ messageId: string }>(res)
			expect(json.ok).toBe(true)
			expect(json.ok && json.value.messageId).toBeDefined()
		})

		it('should return error for non-existent session', async () => {
			const res = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'user-chat.sendMessage',
					input: { sessionId: 'test', agentId: 'test', content: '' },
				}),
			})

			expect(res.status).toBe(200)
			const json = await parseJson<never>(res)
			expect(json.ok).toBe(false)
			expect(!json.ok && json.error.type).toBe('session_not_found')
		})
	})

	describe('sessions.close', () => {
		it('should close a session', async () => {
			// Create session first
			const createRes = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'sessions.create',
					input: { presetId: 'echo-test' },
				}),
			})
			const createJson = await parseJson<{ sessionId: string }>(createRes)
			const sessionId = createJson.ok ? createJson.value.sessionId : ''

			// Close session
			const res = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'sessions.close',
					input: { sessionId },
				}),
			})

			expect(res.status).toBe(200)
			const json = await parseJson<Record<string, never>>(res)
			expect(json.ok).toBe(true)

			// Verify it's closed
			const getRes = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'sessions.get',
					input: { sessionId },
				}),
			})
			const getJson = await parseJson<{ status: string }>(getRes)
			expect(getJson.ok).toBe(true)
			expect(getJson.ok && getJson.value.status).toBe('closed')
		})
	})

	describe('sessions.getEvents', () => {
		it('should return events for a session', async () => {
			// Create session first
			const createRes = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'sessions.create',
					input: { presetId: 'echo-test' },
				}),
			})
			const createJson = await parseJson<{ sessionId: string }>(createRes)
			const sessionId = createJson.ok ? createJson.value.sessionId : ''

			// Get events
			const res = await app.request('/rpc', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'sessions.getEvents',
					input: { sessionId },
				}),
			})

			expect(res.status).toBe(200)
			const json = await parseJson<{ events: { type: string }[]; total: number; lastIndex: number }>(res)
			expect(json.ok).toBe(true)
			if (json.ok) {
				expect(Array.isArray(json.value.events)).toBe(true)
				expect(typeof json.value.total).toBe('number')
				expect(typeof json.value.lastIndex).toBe('number')

				// Should have session_created event
				const hasSessionCreated = json.value.events.some(
					(e) => e.type === 'session_created',
				)
				expect(hasSessionCreated).toBe(true)
			}
		})
	})
})
