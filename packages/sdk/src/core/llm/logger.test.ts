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
import { MemoryLLMCallStore } from '~/testing/memory-llm-call-store.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { LLMLogger } from './logger.js'
import type { LLMLoggerConfig } from './logger.js'
import type { InferenceRequest, InferenceResponse, LLMError } from './provider.js'

// ============================================================================
// Test helpers
// ============================================================================

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
		{ id: 'tc-1' as any, name: 'test_tool', input: { foo: 'bar' } },
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
const SINKS = ['files', 'store']

for (const sink of SINKS) {
	describe(`LLMLogger (${sink})`, () => {
		let testBasePath: string
		let logger: LLMLogger

		beforeEach(async () => {
			testBasePath = join(tmpdir(), `llm-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
			logger = new LLMLogger(createTestConfig({
				basePath: testBasePath,
				store: sink === 'store' ? new MemoryLLMCallStore() : undefined,
			}))
		})

		afterEach(async () => {
			try {
				await rm(testBasePath, { recursive: true, force: true })
			} catch {
				// Ignore cleanup errors
			}
		})

		describe('createCall', () => {
			it('records the request and reads it back', async () => {
				const sessionId = SessionId('test-session-1')
				const agentId = AgentId('test-agent-1')

				const callId = await logger.createCall(sessionId, agentId, createTestRequest())

				expect(callId).toBeTruthy()

				const call = await logger.getCall(sessionId, callId)
				expect(call).not.toBeNull()
				expect(call!.id).toBe(callId)
				expect(call!.sessionId).toBe(sessionId)
				expect(call!.agentId).toBe(agentId)
				expect(call!.status).toBe('running')
				expect(call!.request.model).toBe('test-model')
				expect(call!.request.systemPrompt).toBe('You are a test assistant.')
				expect(call!.request.messages.length).toBe(2)
				expect(call!.request.toolsCount).toBe(1)
				expect(call!.request.tools?.[0]?.name).toBe('test_tool')
			})
		})

		describe('completeCall', () => {
			it('updates call with response data', async () => {
				const sessionId = SessionId('test-session-2')
				const agentId = AgentId('test-agent-1')

				const callId = await logger.createCall(sessionId, agentId, createTestRequest())
				await logger.completeCall(sessionId, callId, createTestResponse(), 150)

				const call = await logger.getCall(sessionId, callId)
				expect(call!.status).toBe('success')
				expect(call!.durationMs).toBe(150)
				expect(call!.response).toBeDefined()
				expect(call!.response!.content).toBe('Test response')
				expect(call!.response!.finishReason).toBe('stop')
				expect(call!.metrics).toBeDefined()
				expect(call!.metrics!.promptTokens).toBe(10)
				expect(call!.metrics!.completionTokens).toBe(5)
				expect(call!.metrics!.cost).toBe(0.001)
			})

			it('leaves the request it belongs to untouched', async () => {
				const sessionId = SessionId('test-session-2b')
				const agentId = AgentId('test-agent-1')

				const callId = await logger.createCall(sessionId, agentId, createTestRequest())
				const before = await logger.getCall(sessionId, callId)
				await logger.completeCall(sessionId, callId, createTestResponse(), 150)

				const after = await logger.getCall(sessionId, callId)
				expect(after!.request).toEqual(before!.request)
			})

			it('handles non-existent call gracefully', async () => {
				const sessionId = SessionId('test-session-3')

				// Should not throw
				await logger.completeCall(sessionId, LLMCallId('non-existent'), createTestResponse(), 100)
			})
		})

		describe('failCall', () => {
			it('updates call with error data', async () => {
				const sessionId = SessionId('test-session-4')
				const agentId = AgentId('test-agent-1')

				const callId = await logger.createCall(sessionId, agentId, createTestRequest())
				await logger.failCall(sessionId, callId, createTestError(), 50)

				const call = await logger.getCall(sessionId, callId)
				expect(call!.status).toBe('error')
				expect(call!.durationMs).toBe(50)
				expect(call!.error).toBeDefined()
				expect(call!.error!.type).toBe('rate_limit')
				expect(call!.error!.message).toBe('Rate limit exceeded')
				expect(call!.error!.retryAfterMs).toBe(5000)
			})

			it('handles non-existent call gracefully', async () => {
				await logger.failCall(SessionId('test-session-4b'), LLMCallId('non-existent'), createTestError(), 50)
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

				// Create multiple calls
				await logger.createCall(sessionId, agentId, createTestRequest())
				await logger.createCall(sessionId, agentId, createTestRequest())
				await logger.createCall(sessionId, agentId, createTestRequest())

				const result = await logger.listCalls(sessionId)
				expect(result.total).toBe(3)
				expect(result.calls.length).toBe(3)
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

				// Create 5 calls
				for (let i = 0; i < 5; i++) {
					await logger.createCall(sessionId, agentId, createTestRequest())
				}

				const result = await logger.listCalls(sessionId, { limit: 2, offset: 1 })
				expect(result.total).toBe(5)
				expect(result.calls.length).toBe(2)
			})

			it('pages without overlapping or skipping', async () => {
				const sessionId = SessionId('test-session-9b')
				const agentId = AgentId('test-agent-1')

				const created: string[] = []
				for (let i = 0; i < 5; i++) {
					created.push(await logger.createCall(sessionId, agentId, createTestRequest()))
				}

				const paged: string[] = []
				for (let offset = 0; offset < 5; offset += 2) {
					const page = await logger.listCalls(sessionId, { limit: 2, offset })
					paged.push(...page.calls.map((call) => call.id))
				}

				// Newest first, and every call seen exactly once.
				expect(paged).toEqual([...created].reverse())
			})

			it('orders calls by most recent first', async () => {
				const sessionId = SessionId('test-session-10')
				const agentId = AgentId('test-agent-1')

				const callId1 = await logger.createCall(sessionId, agentId, createTestRequest())
				// Small delay to ensure different UUIDv7 timestamps
				await new Promise(resolve => setTimeout(resolve, 2))
				const callId2 = await logger.createCall(sessionId, agentId, createTestRequest())

				const result = await logger.listCalls(sessionId)
				// Most recent (callId2) should be first
				expect(result.calls[0].id).toBe(callId2)
				expect(result.calls[1].id).toBe(callId1)
			})

			it('includes a call that has not completed yet', async () => {
				const sessionId = SessionId('test-session-11')
				const agentId = AgentId('test-agent-1')

				await logger.createCall(sessionId, agentId, createTestRequest())

				const result = await logger.listCalls(sessionId)
				expect(result.calls[0].status).toBe('running')
				expect(result.calls[0].response).toBeUndefined()
				expect(result.calls[0].metrics).toBeUndefined()
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

				const result1 = await logger.listCalls(sessionId1)
				const result2 = await logger.listCalls(sessionId2)

				expect(result1.total).toBe(2)
				expect(result2.total).toBe(1)
			})
		})
	})
}

describe('LLMLogger without a store', () => {
	let testBasePath: string

	beforeEach(() => {
		testBasePath = join(tmpdir(), `llm-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
	})

	afterEach(async () => {
		await rm(testBasePath, { recursive: true, force: true }).catch(() => {})
	})

	it('stores call in session folder structure', async () => {
		const logger = new LLMLogger(createTestConfig({ basePath: testBasePath }))
		const sessionId = SessionId('session-abc')
		const agentId = AgentId('agent-1')

		const callId = await logger.createCall(sessionId, agentId, createTestRequest())

		// Verify file exists in correct location
		const callPath = join(testBasePath, 'sessions', sessionId, 'calls', `${callId}.json`)
		const content = await readFile(callPath, 'utf-8')
		const parsed = JSON.parse(content)
		expect(parsed.id).toBe(callId)
	})
})

describe('LLMLogger with a store that has a column ceiling', () => {
	// Nothing reaches the filesystem on this path; the path only has to be a path.
	const basePath = join(tmpdir(), 'llm-logger-clamp-unused')
	const sessionId = SessionId('session-clamp')
	const agentId = AgentId('agent-1')

	/** A message history past what one column can hold, as a long session builds. */
	const hugeRequest = (): InferenceRequest => ({
		...createTestRequest(),
		messages: [{ role: 'user', content: 'x'.repeat(4096) }],
	})

	it('keeps the call when the request does not fit', async () => {
		const logger = new LLMLogger(createTestConfig({ basePath, store: new MemoryLLMCallStore(1024) }))

		const callId = await logger.createCall(sessionId, agentId, hugeRequest())
		await logger.completeCall(sessionId, callId, createTestResponse(), 10)

		const call = await logger.getCall(sessionId, callId)
		// The entry, its metrics and its model survive; only the history goes.
		expect(call!.status).toBe('success')
		expect(call!.metrics!.totalTokens).toBe(15)
		expect(call!.request.model).toBe('test-model')
		expect(call!.request.messages).toHaveLength(1)
		expect(String(call!.request.messages[0].content)).toContain('dropped')
		expect(call!.request.tools).toBeUndefined()
	})

	it('leaves a request that fits alone', async () => {
		const logger = new LLMLogger(createTestConfig({ basePath, store: new MemoryLLMCallStore(1024 * 1024) }))

		const callId = await logger.createCall(sessionId, agentId, createTestRequest())

		const call = await logger.getCall(sessionId, callId)
		expect(call!.request.messages).toHaveLength(2)
		expect(call!.request.tools).toHaveLength(1)
	})
})
