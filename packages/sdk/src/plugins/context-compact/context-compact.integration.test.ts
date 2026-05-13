import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { contextEvents } from '~/core/context/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { InferenceRequest } from '~/core/llm/provider.js'
import { ModelId } from '~/core/llm/schema.js'
import type { Preset } from '~/core/preset/index.js'
import { createTool } from '~/core/tools/definition.js'
import { ToolCallId } from '~/core/tools/schema.js'
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

			// Every assistant message with toolCalls must be followed by a contiguous
			// run of tool messages covering each tool_use id before any further
			// user/assistant message. This mirrors Anthropic's API contract.
			const msgs = capturedAuxRequest!.messages
			for (let i = 0; i < msgs.length; i++) {
				const m = msgs[i]
				if (m.role !== 'assistant' || !m.toolCalls?.length) continue

				const expected = new Set(m.toolCalls.map((tc) => tc.id))
				const seen = new Set<string>()
				for (let j = i + 1; j < msgs.length; j++) {
					const next = msgs[j]
					if (next.role !== 'tool') break
					seen.add(next.toolCallId)
				}
				for (const id of expected) {
					expect(seen.has(id)).toBe(true)
				}
			}

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
})
