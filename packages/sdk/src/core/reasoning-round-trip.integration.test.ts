import { describe, expect, it } from 'bun:test'
import type { AssistantLLMMessage } from '~/core/agents/state.js'
import { MemoryEventStore } from '~/core/events/memory.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { InferenceRequest, InferenceResponse } from '~/core/llm/provider.js'
import { llmEvents } from '~/core/llm/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

// Reasoning blocks have to survive the whole conversation path — the event log,
// a replay of it, and the message list handed to the next inference — or a
// reasoning model restarts its chain of thought at every tool call.

const REASONING_DETAILS = [
	{ type: 'reasoning.encrypted', data: 'EroBCkYIBRgCKkCr0hZ0opaque', id: 'rd-1', format: 'openai-responses-v1', index: 0 },
]

/** The Anthropic half of the same contract — a separate field, see ThinkingBlocks. */
const THINKING_BLOCKS = [
	{ type: 'thinking', thinking: 'Working it out.', signature: 'EqQBCgIYAhIM1gbcDa9GJwZopaque' },
]

const assistantMessages = (request: InferenceRequest): AssistantLLMMessage[] =>
	request.messages.filter((m): m is AssistantLLMMessage => m.role === 'assistant')

/** Same shape as reasoningThenPlainMock, on the Anthropic field. */
const thinkingThenPlainMock = (): MockLLMProvider => {
	let call = 0
	return new MockLLMProvider((): InferenceResponse => {
		call++
		if (call === 1) {
			return {
				content: null,
				toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
				finishReason: 'tool_calls',
				metrics: MockLLMProvider.defaultMetrics(),
				thinkingBlocks: THINKING_BLOCKS,
			}
		}
		return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
	})
}

/** Turn 1 reasons its way to a tool call; every later turn just finishes, without reasoning. */
const reasoningThenPlainMock = (): MockLLMProvider => {
	let call = 0
	return new MockLLMProvider((): InferenceResponse => {
		call++
		if (call === 1) {
			return {
				content: null,
				toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
				finishReason: 'tool_calls',
				metrics: MockLLMProvider.defaultMetrics(),
				reasoningDetails: REASONING_DETAILS,
			}
		}
		return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
	})
}

describe('reasoning round trip', () => {
	it('echoes the blocks back on the follow-up request of the same turn', async () => {
		const llmProvider = reasoningThenPlainMock()
		const harness = new TestHarness({ presets: [createTestPreset()], llmProvider })

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Do something')

		const [, second] = llmProvider.getCallHistory()
		const assistants = assistantMessages(second)
		expect(assistants).toHaveLength(1)
		expect(assistants[0].reasoningDetails).toEqual(REASONING_DETAILS)

		await harness.shutdown()
	})

	it('stores the blocks in the inference_completed event, serialized verbatim', async () => {
		const llmProvider = reasoningThenPlainMock()
		const harness = new TestHarness({ presets: [createTestPreset()], llmProvider })

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Do something')

		const completed = await session.getEventsByType(llmEvents, 'inference_completed')
		expect(completed[0].response.reasoningDetails).toEqual(REASONING_DETAILS)
		// The event is what a restarted server replays, so it has to survive JSON as-is.
		expect(JSON.stringify(completed[0])).toContain(`"reasoningDetails":${JSON.stringify(REASONING_DETAILS)}`)
		expect(completed[1].response.reasoningDetails).toBeUndefined()

		await harness.shutdown()
	})

	it('keeps the blocks after the session is reloaded from the event store', async () => {
		const eventStore = new MemoryEventStore()
		const llmProvider = reasoningThenPlainMock()

		const harness1 = new TestHarness({ eventStore, presets: [createTestPreset()], llmProvider })
		const session1 = await harness1.createSession('test')
		await session1.sendAndWaitForIdle('Do something')
		const sessionId = session1.sessionId
		await harness1.shutdown()

		// Fresh harness over the same log: conversation history comes from replay only.
		const harness2 = new TestHarness({ eventStore, presets: [createTestPreset()], llmProvider })
		const session2 = await harness2.openSession(sessionId)
		await session2.sendAndWaitForIdle('And again')

		const assistants = assistantMessages(llmProvider.getCallHistory()[2])
		expect(assistants[0].reasoningDetails).toEqual(REASONING_DETAILS)

		await harness2.shutdown()
	})

	it('leaves the assistant message untouched when the model returns no reasoning', async () => {
		const llmProvider = MockLLMProvider.withSequence([
			{ toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }] },
			{ content: 'Done', toolCalls: [] },
		])
		const harness = new TestHarness({ presets: [createTestPreset()], llmProvider })

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Do something')

		const assistants = assistantMessages(llmProvider.getCallHistory()[1])
		expect(assistants).toHaveLength(1)
		expect(assistants[0].reasoningDetails).toBeUndefined()

		await harness.shutdown()
	})
})

// Anthropic needs this harder than OpenRouter does: with extended thinking on, the API
// rejects a tool-use turn whose thinking blocks are missing, rather than quietly
// degrading. The two fields stay separate so a mid-conversation model switch cannot put
// one provider's blocks in front of the other.
describe('thinking round trip', () => {
	it('echoes the blocks back on the follow-up request of the same turn', async () => {
		const llmProvider = thinkingThenPlainMock()
		const harness = new TestHarness({ presets: [createTestPreset()], llmProvider })

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Do something')

		const [, second] = llmProvider.getCallHistory()
		const assistants = assistantMessages(second)
		expect(assistants).toHaveLength(1)
		expect(assistants[0].thinkingBlocks).toEqual(THINKING_BLOCKS)
		// The other field stays empty: nothing cross-populates.
		expect(assistants[0].reasoningDetails).toBeUndefined()

		await harness.shutdown()
	})

	it('keeps the blocks after the session is reloaded from the event store', async () => {
		const eventStore = new MemoryEventStore()
		const llmProvider = thinkingThenPlainMock()

		const harness1 = new TestHarness({ eventStore, presets: [createTestPreset()], llmProvider })
		const session1 = await harness1.createSession('test')
		await session1.sendAndWaitForIdle('Do something')
		const sessionId = session1.sessionId
		await harness1.shutdown()

		const harness2 = new TestHarness({ eventStore, presets: [createTestPreset()], llmProvider })
		const session2 = await harness2.openSession(sessionId)
		await session2.sendAndWaitForIdle('And again')

		const assistants = assistantMessages(llmProvider.getCallHistory()[2])
		expect(assistants[0].thinkingBlocks).toEqual(THINKING_BLOCKS)

		await harness2.shutdown()
	})

	it('stores the blocks in the inference_completed event, serialized verbatim', async () => {
		const llmProvider = thinkingThenPlainMock()
		const harness = new TestHarness({ presets: [createTestPreset()], llmProvider })

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Do something')

		const completed = await session.getEventsByType(llmEvents, 'inference_completed')
		expect(JSON.stringify(completed[0])).toContain(`"thinkingBlocks":${JSON.stringify(THINKING_BLOCKS)}`)
		expect(completed[1].response.thinkingBlocks).toBeUndefined()

		await harness.shutdown()
	})
})
