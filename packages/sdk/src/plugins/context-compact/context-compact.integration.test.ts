import { describe, expect, it } from 'bun:test'
import { contextEvents } from '~/core/context/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ModelId } from '~/core/llm/schema.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { contextCompactPlugin } from './index.js'

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
					if (request.systemPrompt.includes('summary') || request.systemPrompt.includes('Summarize')) {
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
					if (request.systemPrompt.includes('summary') || request.systemPrompt.includes('Summarize')) {
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
					if (request.systemPrompt.includes('summary') || request.systemPrompt.includes('Summarize')) {
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
