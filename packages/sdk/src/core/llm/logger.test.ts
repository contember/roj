/**
 * Tests for LLM Logger
 *
 * Every behavioural test runs twice — once against `sessions/<id>/calls/*.json`
 * and once against an `LLMCallStore` — because the move to rows is only allowed
 * to change where the entries live, not what a reader gets back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod/v4'
import { AgentId } from '~/core/agents/schema.js'
import { LLMCallId, ModelId } from '~/core/llm/schema.js'
import { SessionId } from '~/core/sessions/schema.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { countFsCalls, withReadFiles } from '~/lib/utils/fs-batch-doubles.test.js'
import type { LLMCallOutcome, LLMCallPage, LLMCallRow, LLMCallStore } from '~/platform/llm-call-log.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { LLMLogger } from './logger.js'
import type { LLMLoggerConfig } from './logger.js'
import type { InferenceRequest, InferenceResponse, LLMError } from './provider.js'

// ============================================================================
// Test helpers
// ============================================================================

/**
 * What a host with a table for the calls does, without the SQL.
 *
 * Ordering, page boundaries and the missing-call no-op are spelled out here
 * because they are the parts a real host has to get right.
 */
class MemoryLLMCallStore implements LLMCallStore {
	readonly calls = new Map<string, Map<string, LLMCallRow>>()
	/** Every method call, in order — so a test can tell which path actually ran. */
	readonly seen: string[] = []

	constructor(readonly maxBlobBytes?: number) {}

	async create(sessionId: string, row: LLMCallRow): Promise<void> {
		this.seen.push('create')
		let session = this.calls.get(sessionId)
		if (session === undefined) {
			session = new Map()
			this.calls.set(sessionId, session)
		}
		session.set(row.callId, { ...row })
	}

	async complete(sessionId: string, callId: string, outcome: LLMCallOutcome): Promise<void> {
		this.seen.push('complete')
		const row = this.calls.get(sessionId)?.get(callId)
		if (row === undefined) return
		Object.assign(row, outcome)
	}

	async get(sessionId: string, callId: string): Promise<LLMCallRow | null> {
		this.seen.push('get')
		const row = this.calls.get(sessionId)?.get(callId)
		return row === undefined ? null : { ...row }
	}

	async list(sessionId: string, options: { limit: number; offset: number }): Promise<LLMCallPage> {
		this.seen.push('list')
		// UUIDv7 descending, which is newest first and a total order.
		const rows = [...(this.calls.get(sessionId)?.values() ?? [])]
			.sort((a, b) => (a.callId < b.callId ? 1 : a.callId > b.callId ? -1 : 0))

		return {
			calls: rows.slice(options.offset, options.offset + options.limit).map((row) => ({ ...row })),
			total: rows.length,
		}
	}

	async delete(sessionId: string): Promise<number> {
		this.seen.push('delete')
		const removed = this.calls.get(sessionId)?.size ?? 0
		this.calls.delete(sessionId)
		return removed
	}
}

const createTestConfig = (overrides: Partial<LLMLoggerConfig> = {}): LLMLoggerConfig => ({
	basePath: join(tmpdir(), `llm-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`),
	enabled: true,
	fs: createNodeFileSystem(),
	...overrides,
})

const createTestRequest = (): InferenceRequest => {
	return {
		model: ModelId('test-model'),
		systemPrompt: 'You are a test assistant.',
		messages: [
			{ role: 'user', content: 'Hello' },
			{ role: 'assistant', content: 'Hi there!' },
		],
		tools: [
			{ name: 'test_tool', description: 'A test tool', input: z.unknown(), execute: async () => ({ ok: true, value: '' }) },
		],
		maxTokens: 100,
		temperature: 0.7,
	}
}

const createTestResponse = (): InferenceResponse => ({
	content: 'Test response',
	toolCalls: [
		{ id: ToolCallId('tc-1'), name: 'test_tool', input: { foo: 'bar' } },
	],
	finishReason: 'stop',
	metrics: {
		promptTokens: 10,
		completionTokens: 5,
		totalTokens: 15,
		latencyMs: 100,
		model: 'test-model',
		cost: 0.001,
	},
})

const createTestError = (): LLMError => ({
	type: 'rate_limit',
	message: 'Rate limit exceeded',
	retryAfterMs: 5000,
})

// ============================================================================
// Tests
// ============================================================================

/**
 * Files are the status quo; a store is the same logger with `platform.llmCallLog`
 * present. Everything below has to hold either way — a reader cannot tell.
 */
const SINKS = ['files', 'store'] as const

for (const sink of SINKS) {
	describe(`LLMLogger (${sink})`, () => {
		let testBasePath: string
		let store: MemoryLLMCallStore | undefined
		let logger: LLMLogger

		beforeEach(() => {
			testBasePath = join(tmpdir(), `llm-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
			store = sink === 'store' ? new MemoryLLMCallStore() : undefined
			logger = new LLMLogger(createTestConfig({ basePath: testBasePath, store }))
		})

		afterEach(async () => {
			try {
				await rm(testBasePath, { recursive: true, force: true })
			} catch {
				// Ignore cleanup errors
			}
		})

		/** The mechanism, not the output: a store run that quietly wrote files would fail here. */
		const expectSinkUsed = async (sessionId: SessionId, verbs: string[]): Promise<void> => {
			const callsDir = join(testBasePath, 'sessions', sessionId, 'calls')
			if (store === undefined) {
				expect(await createNodeFileSystem().exists(callsDir)).toBe(true)
				return
			}
			expect(store.seen).toEqual(verbs)
			expect(await createNodeFileSystem().exists(callsDir)).toBe(false)
		}

		describe('createCall', () => {
			it('records the request and reads it back', async () => {
				const sessionId = SessionId('test-session-1')
				const agentId = AgentId('test-agent-1')

				const callId = await logger.createCall(sessionId, agentId, createTestRequest())

				expect(callId).toBeTruthy()

				const call = await logger.getCall(sessionId, callId)
				expect(call).not.toBeNull()
				expect(call?.id).toBe(callId)
				expect(call?.sessionId).toBe(sessionId)
				expect(call?.agentId).toBe(agentId)
				expect(call?.status).toBe('running')
				expect(call?.request.model).toBe('test-model')
				expect(call?.request.systemPrompt).toBe('You are a test assistant.')
				expect(call?.request.messages.length).toBe(2)
				expect(call?.request.toolsCount).toBe(1)
				expect(call?.request.tools?.[0]?.name).toBe('test_tool')

				await expectSinkUsed(sessionId, ['create', 'get'])
			})
		})

		describe('completeCall', () => {
			it('updates call with response data', async () => {
				const sessionId = SessionId('test-session-2')
				const agentId = AgentId('test-agent-1')

				const callId = await logger.createCall(sessionId, agentId, createTestRequest())
				await logger.completeCall(sessionId, callId, createTestResponse(), 150)

				const call = await logger.getCall(sessionId, callId)
				expect(call?.status).toBe('success')
				expect(call?.durationMs).toBe(150)
				expect(call?.response?.content).toBe('Test response')
				expect(call?.response?.finishReason).toBe('stop')
				expect(call?.response?.toolCalls[0]?.name).toBe('test_tool')
				expect(call?.metrics?.promptTokens).toBe(10)
				expect(call?.metrics?.completionTokens).toBe(5)
				expect(call?.metrics?.cost).toBe(0.001)
				// The request survives the update untouched.
				expect(call?.request.messages.length).toBe(2)

				await expectSinkUsed(sessionId, ['create', 'complete', 'get'])
			})

			it('handles non-existent call gracefully', async () => {
				const sessionId = SessionId('test-session-3')

				// Should not throw
				await logger.completeCall(sessionId, LLMCallId('non-existent'), createTestResponse(), 100)

				expect(await logger.getCall(sessionId, LLMCallId('non-existent'))).toBeNull()
			})
		})

		describe('failCall', () => {
			it('updates call with error data', async () => {
				const sessionId = SessionId('test-session-4')
				const agentId = AgentId('test-agent-1')

				const callId = await logger.createCall(sessionId, agentId, createTestRequest())
				await logger.failCall(sessionId, callId, createTestError(), 50)

				const call = await logger.getCall(sessionId, callId)
				expect(call?.status).toBe('error')
				expect(call?.durationMs).toBe(50)
				expect(call?.error?.type).toBe('rate_limit')
				expect(call?.error?.message).toBe('Rate limit exceeded')
				expect(call?.error?.retryAfterMs).toBe(5000)

				await expectSinkUsed(sessionId, ['create', 'complete', 'get'])
			})

			it('handles non-existent call gracefully', async () => {
				const sessionId = SessionId('test-session-5')

				await logger.failCall(sessionId, LLMCallId('non-existent'), createTestError(), 50)
			})
		})

		describe('getCall', () => {
			it('returns null for non-existent call', async () => {
				const sessionId = SessionId('test-session-6')

				const call = await logger.getCall(sessionId, LLMCallId('non-existent'))
				expect(call).toBeNull()
			})
		})

		describe('listCalls', () => {
			it('lists all calls for a session', async () => {
				const sessionId = SessionId('test-session-7')
				const agentId = AgentId('test-agent-1')

				await logger.createCall(sessionId, agentId, createTestRequest())
				await logger.createCall(sessionId, agentId, createTestRequest())
				await logger.createCall(sessionId, agentId, createTestRequest())

				const result = await logger.listCalls(sessionId)
				expect(result.total).toBe(3)
				expect(result.calls.length).toBe(3)

				await expectSinkUsed(sessionId, ['create', 'create', 'create', 'list'])
			})

			it('returns empty list for session without calls', async () => {
				const sessionId = SessionId('test-session-8')

				const result = await logger.listCalls(sessionId)
				expect(result.total).toBe(0)
				expect(result.calls.length).toBe(0)
			})

			it('supports pagination', async () => {
				const sessionId = SessionId('test-session-9')
				const agentId = AgentId('test-agent-1')

				const created: LLMCallId[] = []
				for (let i = 0; i < 5; i++) {
					created.push(await logger.createCall(sessionId, agentId, createTestRequest()))
				}

				const result = await logger.listCalls(sessionId, { limit: 2, offset: 1 })
				expect(result.total).toBe(5)
				// Newest first, so offset 1 skips the last one created.
				expect(result.calls.map((call) => call.id)).toEqual([created[3], created[2]])
			})

			it('orders calls by most recent first', async () => {
				const sessionId = SessionId('test-session-10')
				const agentId = AgentId('test-agent-1')

				const callId1 = await logger.createCall(sessionId, agentId, createTestRequest())
				// Small delay to ensure different UUIDv7 timestamps
				await Bun.sleep(2)
				const callId2 = await logger.createCall(sessionId, agentId, createTestRequest())

				const result = await logger.listCalls(sessionId)
				expect(result.calls.map((call) => call.id)).toEqual([callId2, callId1])
			})
		})

		describe('multiple sessions', () => {
			it('isolates calls between sessions', async () => {
				const sessionId1 = SessionId('session-a')
				const sessionId2 = SessionId('session-b')
				const agentId = AgentId('test-agent-1')

				await logger.createCall(sessionId1, agentId, createTestRequest())
				await logger.createCall(sessionId1, agentId, createTestRequest())
				await logger.createCall(sessionId2, agentId, createTestRequest())

				expect((await logger.listCalls(sessionId1)).total).toBe(2)
				expect((await logger.listCalls(sessionId2)).total).toBe(1)
			})
		})
	})
}

describe('LLMLogger over files', () => {
	it('stores call in session folder structure', async () => {
		const testBasePath = join(tmpdir(), `llm-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		const logger = new LLMLogger(createTestConfig({ basePath: testBasePath }))
		const sessionId = SessionId('session-abc')

		const callId = await logger.createCall(sessionId, AgentId('agent-1'), createTestRequest())

		const callPath = join(testBasePath, 'sessions', sessionId, 'calls', `${callId}.json`)
		expect(JSON.parse(await readFile(callPath, 'utf-8')).id).toBe(callId)

		await rm(testBasePath, { recursive: true, force: true })
	})

	it('asks the platform for the whole page at once where it takes a set', async () => {
		const testBasePath = join(tmpdir(), `llm-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		const loop = countFsCalls(createNodeFileSystem())
		const batch = countFsCalls(withReadFiles(createNodeFileSystem()))
		const sessionId = SessionId('session-page')

		const write = async (fs: LLMLoggerConfig['fs']) => {
			const logger = new LLMLogger(createTestConfig({ basePath: join(testBasePath, String(Math.random())), fs }))
			for (let i = 0; i < 3; i++) await logger.createCall(sessionId, AgentId('agent-1'), createTestRequest())
			return logger.listCalls(sessionId)
		}

		const viaLoop = await write(loop.fs)
		const viaBatch = await write(batch.fs)

		expect(viaBatch.total).toBe(3)
		expect(viaBatch.calls.map((call) => call.request.model)).toEqual(viaLoop.calls.map((call) => call.request.model))
		// One question for the page instead of one read per file.
		expect(batch.calls.readFiles).toBe(1)
		expect(batch.calls.readFile).toBeUndefined()
		expect(loop.calls.readFile).toBe(3)

		await rm(testBasePath, { recursive: true, force: true })
	})
})

describe('LLMLogger over a store with a column ceiling', () => {
	const storedRequest = (store: MemoryLLMCallStore, sessionId: string, callId: string): string => {
		const row = store.calls.get(sessionId)?.get(callId)
		if (row === undefined) throw new Error(`no row for ${callId}`)
		return row.request
	}

	it('hands over the whole request when it fits', async () => {
		const store = new MemoryLLMCallStore(1_000_000)
		const logger = new LLMLogger(createTestConfig({ store }))
		const sessionId = SessionId('clamp-fits')

		const callId = await logger.createCall(sessionId, AgentId('a1'), createTestRequest())

		expect(JSON.parse(storedRequest(store, sessionId, callId)).messages).toHaveLength(2)
	})

	it('clamps an oversized request instead of letting the store reject it', async () => {
		const maxBlobBytes = 2_000
		const store = new MemoryLLMCallStore(maxBlobBytes)
		const logger = new LLMLogger(createTestConfig({ store }))
		const sessionId = SessionId('clamp-drops')
		const request = createTestRequest()
		request.messages = [{ role: 'user', content: 'x'.repeat(50_000) }]

		const callId = await logger.createCall(sessionId, AgentId('a1'), request)

		const stored = storedRequest(store, sessionId, callId)
		expect(new TextEncoder().encode(stored).byteLength).toBeLessThanOrEqual(maxBlobBytes)
		// The call is still listed, with its model and prompt intact.
		const parsed = JSON.parse(stored)
		expect(parsed.model).toBe('test-model')
		expect(parsed.systemPrompt).toBe('You are a test assistant.')
		expect(parsed.messages[0].content).toContain('dropped')
	})

	it('fits the row even when the system prompt alone is over the ceiling', async () => {
		const maxBlobBytes = 200
		const store = new MemoryLLMCallStore(maxBlobBytes)
		const logger = new LLMLogger(createTestConfig({ store }))
		const sessionId = SessionId('clamp-prompt')
		const request = createTestRequest()
		request.systemPrompt = 'y'.repeat(10_000)

		const callId = await logger.createCall(sessionId, AgentId('a1'), request)

		const stored = storedRequest(store, sessionId, callId)
		expect(new TextEncoder().encode(stored).byteLength).toBeLessThanOrEqual(maxBlobBytes)
	})

	it('clamps by bytes, not by UTF-16 units', async () => {
		// 900 astral characters: 1800 UTF-16 units, 3600 UTF-8 bytes.
		const maxBlobBytes = 3_000
		const store = new MemoryLLMCallStore(maxBlobBytes)
		const logger = new LLMLogger(createTestConfig({ store }))
		const sessionId = SessionId('clamp-utf8')
		const request = createTestRequest()
		request.messages = [{ role: 'user', content: '𝄞'.repeat(900) }]

		const callId = await logger.createCall(sessionId, AgentId('a1'), request)

		expect(new TextEncoder().encode(storedRequest(store, sessionId, callId)).byteLength)
			.toBeLessThanOrEqual(maxBlobBytes)
	})
})

describe('LLMLogger over a store that forgot the call', () => {
	it('treats complete on an unknown id as a no-op, not a throw', async () => {
		const store = new MemoryLLMCallStore()
		const logger = new LLMLogger(createTestConfig({ store }))
		const sessionId = SessionId('reaped')
		const callId = await logger.createCall(sessionId, AgentId('a1'), createTestRequest())
		await store.delete(sessionId)

		await logger.completeCall(sessionId, callId, createTestResponse(), 10)
		await logger.failCall(sessionId, callId, createTestError(), 10)

		expect(await logger.getCall(sessionId, callId)).toBeNull()
	})
})
