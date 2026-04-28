import { beforeEach, describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { generateTestAgentId } from '~/core/agents/schema.js'
import { MemoryEventStore } from '~/core/events/index.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ModelId } from '~/core/llm/schema.js'
import { generateSessionId } from '~/core/sessions/schema.js'
import { createSessionState } from '~/core/sessions/state.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { silentLogger } from '../../lib/logger/logger.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { SessionFileStore } from '../file-store/file-store.js'
import type { ToolContext } from './context.js'
import { createTool } from './definition.js'
import { ToolExecutor } from './executor.js'

// ============================================================================
// Test Helpers
// ============================================================================

const createTestContext = (): ToolContext => {
	const sessionId = generateSessionId()
	const agentId = generateTestAgentId()
	const sessionState = createSessionState(sessionId, 'test', Date.now())
	const fileStore = new SessionFileStore('/tmp/test-session', undefined, false, createNodePlatform().fs)
	const agentState = {
		id: agentId,
		definitionName: 'test',
		parentId: null,
		status: 'pending' as const,
		conversationHistory: [],
		preamble: [],
		pendingToolCalls: [],
		pendingToolResults: [],
		pendingMessages: [],
	}
	return {
		sessionId,
		sessionState,
		sessionInput: undefined,
		environment: { sessionDir: '/tmp/test-session', sandboxed: false },
		llm: MockLLMProvider.withFixedResponse({ content: '', toolCalls: [], finishReason: 'stop' }),
		files: fileStore,
		eventStore: new MemoryEventStore(),
		platform: createNodePlatform(),
		logger: silentLogger,
		emitEvent: async () => {},
		notify: () => {},
		agentId,
		agentState,
		agentConfig: { systemPrompt: 'test', model: ModelId('test'), spawnableAgents: [] },
		input: undefined,
		parentId: null,
	}
}

// ============================================================================
// Tests
// ============================================================================

describe('ToolExecutor', () => {
	let executor: ToolExecutor

	beforeEach(() => {
		executor = new ToolExecutor(silentLogger)
	})

	describe('execute', () => {
		it('executes tool successfully', async () => {
			const tool = createTool({
				name: 'add_one',
				description: 'Adds one to the input value',
				input: z.object({ value: z.number() }),
				execute: async (input) => Ok(JSON.stringify({ result: input.value + 1 })),
			})

			const context = createTestContext()
			const result = await executor.execute(tool, { value: 5 }, context)

			expect(result.ok).toBe(true)
			if (!result.ok) return
			// Tool returns JSON string directly
			expect(result.value).toBe('{"result":6}')
		})

		it('handles tool failure', async () => {
			const tool = createTool({
				name: 'failing_tool',
				description: 'Fails intentionally',
				input: z.object({}),
				execute: async () => Err({ message: 'Something went wrong', recoverable: false }),
			})

			const context = createTestContext()
			const result = await executor.execute(tool, {}, context)

			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.error.message).toBe('Something went wrong')
		})

		it('catches exceptions and returns error', async () => {
			const tool = createTool({
				name: 'throwing_tool',
				description: 'Throws an error',
				input: z.object({}),
				execute: async () => {
					throw new Error('Unexpected error')
				},
			})

			const context = createTestContext()
			const result = await executor.execute(tool, {}, context)

			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.error.message).toBe('Unexpected error')
			expect(result.error.recoverable).toBe(false)
		})

		it('catches non-Error throws', async () => {
			const tool = createTool({
				name: 'throwing_string',
				description: 'Throws a string',
				input: z.object({}),
				execute: async () => {
					throw 'string error'
				},
			})

			const context = createTestContext()
			const result = await executor.execute(tool, {}, context)

			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.error.message).toBe('string error')
		})

		it('passes context to tool', async () => {
			let capturedContext: ToolContext | null = null

			const tool = createTool({
				name: 'capture_context',
				description: 'Captures context',
				input: z.object({}),
				execute: async (_, ctx) => {
					capturedContext = ctx
					return Ok('captured')
				},
			})

			const context = createTestContext()
			await executor.execute(tool, {}, context)

			expect(capturedContext).toBeDefined()
			expect(capturedContext!.sessionId).toBe(context.sessionId)
			expect(capturedContext!.agentId).toBe(context.agentId)
		})
	})
})
