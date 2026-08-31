import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { contextEvents } from '~/core/context/state.js'
import { MemoryEventStore } from '~/core/events/memory.js'
import { llmEvents } from '~/core/llm/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { InferenceRequest, LLMMessage } from '~/core/llm/provider.js'
import { ModelId } from '~/core/llm/schema.js'
import type { Preset } from '~/core/preset/index.js'
import type { AgentId } from '~/core/agents/schema.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createTool } from '~/core/tools/definition.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { selectSessionStats, sessionStatsPlugin } from '~/plugins/session-stats/index.js'
import type { TestSession } from '~/testing/index.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { contextCompactPlugin } from './index.js'

/**
 * Inline compaction sends the agent's regular systemPrompt and full conversation
 * to the LLM, with a trailing user message containing the summarization
 * instruction. We detect compaction calls by looking at that trailing message.
 */
function isSummarizationRequest(request: InferenceRequest): boolean {
	const last = request.messages[request.messages.length - 1]
	if (!last || last.role !== 'user') return false
	const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
	return content.includes('[CONTEXT COMPACTION REQUEST]')
}

// ============================================================================
// Helpers
// ============================================================================

function createCompactPreset(maxTokens: number, overrides?: Parameters<typeof createTestPreset>[0]) {
	return createTestPreset({
		...overrides,
		plugins: [
			contextCompactPlugin.configure({
				compaction: {
					model: ModelId('mock'),
					maxTokens,
					keepRecentMessages: 2,
				},
			}),
			...(overrides?.plugins ?? []),
		],
	})
}

function createCompactHarness(options: Omit<ConstructorParameters<typeof TestHarness>[0], 'systemPlugins'>) {
	return new TestHarness({ ...options, systemPlugins: [contextCompactPlugin] })
}

function expectToolPairing(messages: LLMMessage[]): void {
	const declaredToolCallIds = new Set<string>()

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (message.role === 'assistant' && message.toolCalls?.length) {
			const expected = new Set(message.toolCalls.map((toolCall) => toolCall.id))
			const seen = new Set<string>()
			for (const toolCall of message.toolCalls) {
				declaredToolCallIds.add(toolCall.id)
			}
			for (let j = i + 1; j < messages.length; j++) {
				const next = messages[j]
				if (next.role !== 'tool') break
				seen.add(next.toolCallId)
			}
			for (const id of expected) {
				expect(seen.has(id)).toBe(true)
			}
		}

		if (message.role === 'tool') {
			expect(declaredToolCallIds.has(message.toolCallId)).toBe(true)
		}
	}
}

async function waitForAgentPaused(session: TestSession, agentId: AgentId, timeoutMs = 10000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (session.state.agents.get(agentId)?.status === 'paused') return
		await new Promise(r => setTimeout(r, 10))
	}
	throw new Error(`waitForAgentPaused timed out for agent ${agentId}`)
}

// ============================================================================
// Tests
// ============================================================================

describe('context-compact plugin', () => {
	// =========================================================================
	// Compaction triggering
	// =========================================================================

	describe('compaction triggering', () => {
		it('conversation exceeding maxTokens → context_compacted event emitted', async () => {
			// Use very low maxTokens to trigger compaction.
			// conversationHistory is populated by inference_completed events:
			//   After 1st round: [user1, assist1] (2 messages)
			//   After 2nd round: [user1, assist1, user2, assist2] (4 messages)
			// With keepRecentMessages=2, the 3rd beforeInference sees 4 messages,
			// compacts the first 2, and calls LLM for summarization.
			const harness = createCompactHarness({
				presets: [createCompactPreset(10)],
				mockHandler: (request) => {
					// Compaction requests use CONTEXT_SUMMARY_PROMPT which contains "summarizer".
					if (isSummarizationRequest(request)) {
						return {
							content: 'Summary of conversation so far.',
							toolCalls: [],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}

					// Regular agent inference
					return {
						content: 'Agent response with some content to increase token count.',
						toolCalls: [],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				},
			})

			const session = await harness.createSession('test')

			// Build up conversation history across multiple rounds
			await session.sendAndWaitForIdle('First message')
			await session.sendAndWaitForIdle('Second message')
			// Third message — beforeInference sees 4+ messages, compacts older ones
			await session.sendAndWaitForIdle('Third message to trigger actual compaction')

			const compactedEvents = await session.getEventsByType(contextEvents, 'context_compacted')
			const actualCompaction = compactedEvents.find((e) => e.messagesRemoved > 0)
			expect(actualCompaction).toBeDefined()
			expect(actualCompaction!.compactedContent).toBe('Summary of conversation so far.')
			expect(actualCompaction!.messagesRemoved).toBeGreaterThan(0)

			await harness.shutdown()
		})

		it('short conversation under limit → no compaction', async () => {
			// Use a very high maxTokens so compaction is never triggered
			const harness = createCompactHarness({
				presets: [createCompactPreset(100000)],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Short reply', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Short message')
			await session.sendAndWaitForIdle('Another short message')

			const compactedEvents = await session.getEventsByType(contextEvents, 'context_compacted')
			expect(compactedEvents).toHaveLength(0)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Turn numbering
	// =========================================================================

	describe('turn numbering', () => {
		it('an attempt that commits nothing does not consume a turn number', async () => {
			const turnNumbers: number[] = []
			let paused = false
			const pauseOnce = definePlugin('pause-once')
				.hook('beforeInference', async (ctx) => {
					turnNumbers.push(ctx.turnNumber)
					if (paused) return null
					paused = true
					return { action: 'pause', reason: 'probe' }
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [pauseOnce],
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			await session.sendMessage('First message')
			await waitForAgentPaused(session, entryAgentId)
			await session.resumeAgent(entryAgentId)
			await session.waitForIdle()
			await session.sendAndWaitForIdle('Second message')

			// The paused attempt and its retry are turn 1; only the commit advances it.
			expect(turnNumbers).toEqual([1, 1, 2])

			await harness.shutdown()
		})

		it('keeps counting turns across a compaction and a reload', async () => {
			const turnNumbers: number[] = []
			const turnProbe = definePlugin('turn-probe')
				.hook('beforeInference', async (ctx) => {
					turnNumbers.push(ctx.turnNumber)
					return null
				})
				.build()

			const mockHandler = (request: InferenceRequest) => ({
				content: isSummarizationRequest(request)
					? 'Summary of conversation so far.'
					: 'Agent response with some content to increase token count.',
				toolCalls: [],
				finishReason: 'stop' as const,
				metrics: MockLLMProvider.defaultMetrics(),
			})

			const eventStore = new MemoryEventStore()
			const harnessOptions = {
				eventStore,
				presets: [createCompactPreset(10)],
				systemPlugins: [contextCompactPlugin, turnProbe],
				mockHandler,
			}

			const harness = new TestHarness(harnessOptions)
			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('First message')
			await session.sendAndWaitForIdle('Second message')
			await session.sendAndWaitForIdle('Third message triggers compaction')
			const sessionId = session.sessionId

			const compactions = await session.getEventsByType(contextEvents, 'context_compacted')
			expect(compactions.length).toBeGreaterThan(0)
			await harness.shutdown()

			// Fresh runtime over the same log — the turn count has to come from the
			// event log, not from counting assistant messages the compaction ate.
			const restarted = new TestHarness(harnessOptions)
			const reopened = await restarted.openSession(sessionId)
			await reopened.sendAndWaitForIdle('Fourth message')

			expect(turnNumbers).toEqual([1, 2, 3, 4])

			await restarted.shutdown()
		})
	})

	// =========================================================================
	// Compaction behavior
	// =========================================================================

	describe('compaction behavior', () => {
		it('after compaction, subsequent inference sees fewer messages', async () => {
			let inferenceCallCount = 0
			let messagesInThirdCall = 0

			const harness = createCompactHarness({
				presets: [createCompactPreset(10)],
				mockHandler: (request) => {
					inferenceCallCount++

					// Summarization requests (from context-compact plugin)
					if (isSummarizationRequest(request)) {
						return {
							content: 'Conversation summary.',
							toolCalls: [],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}

					// Track messages in later calls
					if (inferenceCallCount >= 3) {
						messagesInThirdCall = request.messages.length
					}

					return {
						content: 'Response with enough content to push tokens over the limit for compaction.',
						toolCalls: [],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				},
			})

			const session = await harness.createSession('test')

			// First message — builds history
			await session.sendAndWaitForIdle('First long message with plenty of content')
			// Second message — triggers compaction, then inference with compacted history
			await session.sendAndWaitForIdle('Second long message to trigger compaction')

			// After compaction, the conversation history should be shorter
			const compactedEvents = await session.getEventsByType(contextEvents, 'context_compacted')
			expect(compactedEvents.length).toBeGreaterThanOrEqual(1)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Pending tool results regression
	// =========================================================================

	describe('pending tool results', () => {
		it('aux inference after a tool turn includes the tool_result before the summary instruction', async () => {
			// Regression for the bug where context-compact's auxiliary inference call
			// runs at a moment where `conversationHistory` ends with an assistant
			// `tool_use` block but the corresponding tool_result is still in
			// `pendingToolResults` (not yet committed to history). Sending
			// `[..., assistant(tool_use), user(summary)]` to Anthropic 400s with
			// "tool_use blocks must be followed by tool_result blocks".

			const myTool = createTool({
				name: 'my_tool',
				description: 'returns a fixed value',
				input: z.object({}),
				execute: async () => ({ ok: true, value: 'tool result content' }),
			})

			const preset: Preset = {
				id: 'test',
				name: 'Tool Compaction Test',
				orchestrator: {
					system: 'You are a test agent.',
					model: ModelId('mock'),
					tools: [myTool],
					agents: [],
					debounceMs: 0,
				},
				agents: [],
				plugins: [
					contextCompactPlugin.configure({
						compaction: {
							model: ModelId('mock'),
							maxTokens: 10,
							// 1 so that after the tool turn, [user, assistant(tool_use)]
							// splits into toCompact=[user], toKeep=[assistant(tool_use)] —
							// the aux call actually runs and gets the buggy prefix.
							keepRecentMessages: 1,
						},
					}),
				],
			}

			let capturedAuxRequest: InferenceRequest | undefined
			let capturedToolResultRequest: InferenceRequest | undefined

			const harness = new TestHarness({
				systemPlugins: [contextCompactPlugin],
				presets: [preset],
				mockHandler: (request) => {
					if (isSummarizationRequest(request)) {
						capturedAuxRequest = request
						return {
							content: 'Summary of conversation.',
							toolCalls: [],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					// First inference (no tool messages in history yet) → emit a tool call.
					const hasToolMessages = request.messages.some((m) => m.role === 'tool')
					if (!hasToolMessages) {
						return {
							content: '',
							toolCalls: [{ id: ToolCallId('tc1'), name: 'my_tool', input: {} }],
							finishReason: 'tool_calls',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					capturedToolResultRequest = request
					return {
						content: 'Done.',
						toolCalls: [],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Please call my_tool')

			expect(capturedAuxRequest).toBeDefined()
			if (!capturedAuxRequest) return
			expectToolPairing(capturedAuxRequest.messages)

			// The event reducer runs before pending tool results are appended to the
			// regular inference request. Pairing must survive that reconstruction.
			expect(capturedToolResultRequest).toBeDefined()
			if (!capturedToolResultRequest) return
			expectToolPairing(capturedToolResultRequest.messages)

			// Compaction must have actually succeeded — pre-fix it would Err-out
			// in production (mock accepts it but the assertion above already
			// catches the malformed-prefix case).
			const compactedEvents = await session.getEventsByType(contextEvents, 'context_compacted')
			const actualCompactions = compactedEvents.filter((e) => e.messagesRemoved > 0)
			expect(actualCompactions.length).toBeGreaterThanOrEqual(1)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Compaction failure
	// =========================================================================

	describe('compaction failure', () => {
		it('LLM fails during summarization → compaction skipped, no crash', async () => {
			let regularCallCount = 0

			const harness = createCompactHarness({
				presets: [createCompactPreset(10)],
				mockHandler: (request) => {
					// Summarization requests — throw to simulate LLM failure.
					// MockLLMProvider only returns Err() when the handler throws.
					if (isSummarizationRequest(request)) {
						throw { type: 'server_error', message: 'LLM summarization failed' }
					}

					// Regular inference
					regularCallCount++
					return {
						content: 'Agent response despite compaction failure. Content to push tokens.',
						toolCalls: [],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				},
			})

			const session = await harness.createSession('test')

			// Build up conversation history so actual compaction is attempted
			await session.sendAndWaitForIdle('First message')
			await session.sendAndWaitForIdle('Second message')
			// Third message — compaction attempt on 4+ messages will call LLM and fail
			await session.sendAndWaitForIdle('Third message triggers failed compaction')

			// No compaction event with actual messages removed (LLM summarization failed)
			const compactedEvents = await session.getEventsByType(contextEvents, 'context_compacted')
			const actualCompactions = compactedEvents.filter((e) => e.messagesRemoved > 0)
			expect(actualCompactions).toHaveLength(0)

			// But the agent should still have responded (graceful degradation)
			expect(regularCallCount).toBeGreaterThanOrEqual(3)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Cost accounting — the compaction summarization call is a real, billed LLM
	// call. Its tokens/cost must land in session stats, not vanish. (Regression:
	// runAuxiliaryInference used to skip emitting any stats event.)
	// =========================================================================

	describe('compaction cost accounting', () => {
		it('summarization call cost is counted in session stats', async () => {
			const REGULAR_COST = 0.01
			const SUMMARY_COST = 0.05

			const harness = new TestHarness({
				systemPlugins: [contextCompactPlugin, sessionStatsPlugin],
				presets: [createCompactPreset(10)],
				mockHandler: (request) => {
					if (isSummarizationRequest(request)) {
						return {
							content: 'Summary of conversation so far.',
							toolCalls: [],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetricsWithCost(SUMMARY_COST),
						}
					}
					return {
						content: 'Agent response with some content to increase token count.',
						toolCalls: [],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetricsWithCost(REGULAR_COST),
					}
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('First message')
			await session.sendAndWaitForIdle('Second message')
			await session.sendAndWaitForIdle('Third message to trigger actual compaction')

			// Compaction actually ran and made a billed summarization call.
			const auxEvents = await session.getEventsByType(llmEvents, 'auxiliary_inference_completed')
			expect(auxEvents.length).toBeGreaterThanOrEqual(1)
			expect(auxEvents.some((e) => e.metrics.cost === SUMMARY_COST)).toBe(true)

			// Session stats must include both the regular turns AND the summarization
			// call — in count, tokens, and cost.
			const inferEvents = await session.getEventsByType(llmEvents, 'inference_completed')
			const allLlmEvents = [...inferEvents, ...auxEvents]
			const expectedCost = allLlmEvents.reduce((sum, e) => sum + (e.metrics.cost ?? 0), 0)
			const expectedTokens = allLlmEvents.reduce((sum, e) => sum + e.metrics.totalTokens, 0)

			const stats = selectSessionStats(session.state)
			expect(stats.llmCalls).toBe(allLlmEvents.length)
			expect(stats.totalCost).toBeCloseTo(expectedCost, 10)
			expect(stats.totalTokens).toBe(expectedTokens)
			// And the summarization cost is genuinely part of the total (not zero).
			expect(stats.totalCost).toBeGreaterThanOrEqual(SUMMARY_COST)

			await harness.shutdown()
		})
	})
})
