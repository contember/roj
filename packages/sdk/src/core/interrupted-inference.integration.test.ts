import { afterEach, describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryEventStore } from '~/core/events/memory.js'
import { LLMLogger } from '~/core/llm/logger.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { AssistantLLMMessage } from '~/core/agents/state.js'
import type { InferenceResponse } from '~/core/llm/provider.js'
import { llmEvents } from '~/core/llm/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { selectSessionStats } from '~/plugins/session-stats/index.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

// A run that dies while its turn is in flight leaves inference_started without
// inference_completed, and the next run makes the turn again. When the response
// already reached the call log, the next run commits it instead of paying for it
// twice; otherwise it sends the request again and says so.

const answer = (content: string): InferenceResponse => ({
	content,
	toolCalls: [],
	finishReason: 'stop',
	metrics: MockLLMProvider.defaultMetrics(),
})

/** Dies right after the response is logged: inference_completed is never written. */
class DyingAfterLog extends LLMLogger {
	readonly logged = Promise.withResolvers<void>()
	readonly release = Promise.withResolvers<void>()

	override async completeCall(...args: Parameters<LLMLogger['completeCall']>): Promise<void> {
		await super.completeCall(...args)
		this.logged.resolve()
		await this.release.promise
	}
}

/** A provider whose first call never comes back, as one an eviction cut off. */
function hangingProvider() {
	const called = Promise.withResolvers<void>()
	const cut = Promise.withResolvers<InferenceResponse>()
	const provider = new MockLLMProvider(() => {
		called.resolve()
		return cut.promise
	})
	return { provider, called: called.promise, release: () => cut.reject(new Error('evicted')) }
}

const basePaths: string[] = []
const loggerConfig = (basePath: string) => ({ basePath, enabled: true, fs: createNodeFileSystem() })

function callLogPath(): string {
	const basePath = join(tmpdir(), `interrupted-inference-${Date.now()}-${Math.random().toString(36).slice(2)}`)
	basePaths.push(basePath)
	return basePath
}

afterEach(async () => {
	for (const basePath of basePaths.splice(0)) await rm(basePath, { recursive: true, force: true })
})

describe('an inference interrupted by a restart', () => {
	it('commits the logged response instead of calling the provider again', async () => {
		const eventStore = new MemoryEventStore()
		const basePath = callLogPath()
		const dying = new DyingAfterLog(loggerConfig(basePath))
		const first = new TestHarness({ eventStore, presets: [createTestPreset()], llmLogger: dying, mockHandler: () => answer('Logged answer.') })
		const session1 = await first.createSession('test')
		await session1.sendMessage('Hi')
		await dying.logged.promise

		const resumed = new MockLLMProvider(() => answer('Fresh answer.'))
		const llmLogger = new LLMLogger(loggerConfig(basePath))
		const second = new TestHarness({ eventStore, presets: [createTestPreset()], llmLogger, llmProvider: resumed })
		const session2 = await second.openSession(session1.sessionId)
		await session2.waitForIdle()

		expect(resumed.getCallHistory()).toHaveLength(0)
		const [started, restarted] = await session2.getEventsByType(llmEvents, 'inference_started')
		expect(restarted.llmCallId).toBe(started.llmCallId)
		expect(restarted.retried).toBeUndefined()
		const [completed] = await session2.getEventsByType(llmEvents, 'inference_completed')
		expect(completed.response.content).toBe('Logged answer.')
		expect(completed.llmCallId).toBe(started.llmCallId)
		expect(selectSessionStats(session2.state).retriedInferences).toBe(0)

		// The dead run drains its turn on shutdown, so it is let go only once the resumed one is down.
		await second.shutdown()
		dying.release.resolve()
		await first.shutdown()
	})

	it('replays a logged tool call with its thinking blocks, and carries on from it', async () => {
		const thinkingBlocks = [{ type: 'thinking', thinking: 'Greet them.', signature: 'sig' }]
		const eventStore = new MemoryEventStore()
		const basePath = callLogPath()
		const dying = new DyingAfterLog(loggerConfig(basePath))
		const first = new TestHarness({
			eventStore,
			presets: [createTestPreset()],
			llmLogger: dying,
			mockHandler: () => ({
				content: null,
				toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
				finishReason: 'tool_calls',
				metrics: MockLLMProvider.defaultMetrics(),
				thinkingBlocks,
			}),
		})
		const session1 = await first.createSession('test')
		await session1.sendMessage('Hi')
		await dying.logged.promise

		const resumed = new MockLLMProvider(() => answer('Done.'))
		const second = new TestHarness({ eventStore, presets: [createTestPreset()], llmLogger: new LLMLogger(loggerConfig(basePath)), llmProvider: resumed })
		const session2 = await second.openSession(session1.sessionId)
		await session2.waitForIdle()

		const [replayed] = await session2.getEventsByType(llmEvents, 'inference_completed')
		expect(replayed.response.toolCalls.map((toolCall) => toolCall.name)).toEqual(['tell_user'])
		expect(replayed.response.thinkingBlocks).toEqual(thinkingBlocks)
		// The only provider call is the turn after the replayed tool call ran.
		expect(resumed.getCallHistory()).toHaveLength(1)
		const assistants = resumed.getCallHistory()[0].messages.filter((m): m is AssistantLLMMessage => m.role === 'assistant')
		expect(assistants[0].thinkingBlocks).toEqual(thinkingBlocks)

		await second.shutdown()
		dying.release.resolve()
		await first.shutdown()
	})

	it('calls the provider again when the first call never came back, and marks the retry', async () => {
		const eventStore = new MemoryEventStore()
		const basePath = callLogPath()
		const cutOff = hangingProvider()
		const first = new TestHarness({ eventStore, presets: [createTestPreset()], llmLogger: new LLMLogger(loggerConfig(basePath)), llmProvider: cutOff.provider })
		const session1 = await first.createSession('test')
		await session1.sendMessage('Hi')
		await cutOff.called

		const resumed = new MockLLMProvider(() => answer('Fresh answer.'))
		const llmLogger = new LLMLogger(loggerConfig(basePath))
		const second = new TestHarness({ eventStore, presets: [createTestPreset()], llmLogger, llmProvider: resumed })
		const session2 = await second.openSession(session1.sessionId)
		await session2.waitForIdle()

		expect(resumed.getCallHistory()).toHaveLength(1)
		const [started, retried] = await session2.getEventsByType(llmEvents, 'inference_started')
		expect(retried.retried).toBe(true)
		expect(retried.llmCallId).not.toBe(started.llmCallId)
		const [completed] = await session2.getEventsByType(llmEvents, 'inference_completed')
		expect(completed.response.content).toBe('Fresh answer.')
		expect(completed.llmCallId).toBe(retried.llmCallId)
		if (retried.llmCallId === undefined) throw new Error('the retried turn records its call id')
		expect((await llmLogger.getCall(session2.sessionId, retried.llmCallId))?.retried).toBe(true)
		expect(selectSessionStats(session2.state).retriedInferences).toBe(1)

		await second.shutdown()
		cutOff.release()
		await first.shutdown()
	})

	it('calls the provider again when input arrived since, rather than commit an answer that never saw it', async () => {
		const eventStore = new MemoryEventStore()
		const basePath = callLogPath()
		const dying = new DyingAfterLog(loggerConfig(basePath))
		const first = new TestHarness({ eventStore, presets: [createTestPreset()], llmLogger: dying, mockHandler: () => answer('Logged answer.') })
		const session1 = await first.createSession('test')
		await session1.sendMessage('Hi')
		await dying.logged.promise
		await session1.sendMessage('Are you there?')

		const resumed = new MockLLMProvider(() => answer('Fresh answer.'))
		const second = new TestHarness({ eventStore, presets: [createTestPreset()], llmLogger: new LLMLogger(loggerConfig(basePath)), llmProvider: resumed })
		const session2 = await second.openSession(session1.sessionId)
		await session2.waitForIdle()

		expect(resumed.getCallHistory()).toHaveLength(1)
		const [completed] = await session2.getEventsByType(llmEvents, 'inference_completed')
		expect(completed.response.content).toBe('Fresh answer.')
		expect(selectSessionStats(session2.state).retriedInferences).toBe(1)

		await second.shutdown()
		dying.release.resolve()
		await first.shutdown()
	})
})
