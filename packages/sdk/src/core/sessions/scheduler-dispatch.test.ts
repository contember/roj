/**
 * Scheduler wake dispatch — the entry point a host calls when a delay it was
 * holding elapses.
 *
 * These tests use a scheduler that records wakes and never fires them, which is
 * the shape of an alarm-driven host: arming and delivering are separate events,
 * and delivery may land in a process that never armed anything.
 */

import { describe, expect, it } from 'bun:test'
import { agentWakeKey } from '~/core/agents/wake-key.js'
import { MemoryEventStore } from '~/core/events/memory.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { InferenceResponse } from '~/core/llm/provider.js'
import { SessionId } from '~/core/sessions/schema.js'
import type { Platform } from '~/platform/index.js'
import { createTestPreset } from '~/testing/preset-helpers.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import type { Scheduler } from '~/platform/index.js'
import { TestHarness } from '~/testing/test-harness.js'
import { AgentId } from '~/core/agents/schema.js'

/** Records wakes and never fires them — the test decides when one comes due. */
class RecordingScheduler implements Scheduler {
	readonly armed = new Map<string, number>()
	readonly cancelled: string[] = []

	async wake(key: string, delayMs: number): Promise<void> {
		this.armed.set(key, delayMs)
	}

	async cancel(key: string): Promise<void> {
		this.armed.delete(key)
		this.cancelled.push(key)
	}
}

const recordingPlatform = (): { platform: Platform; scheduler: RecordingScheduler } => {
	const scheduler = new RecordingScheduler()
	return { platform: { ...createNodePlatform(), scheduler }, scheduler }
}

const okResponse = (content: string): InferenceResponse => ({
	content,
	toolCalls: [],
	finishReason: 'stop',
	metrics: MockLLMProvider.defaultMetrics(),
})

describe('SessionManager.dispatchWake', () => {
	it('runs the agent turn the debounce wake stands for, instead of re-arming it', async () => {
		const { platform, scheduler } = recordingPlatform()
		const harness = new TestHarness({
			presets: [createTestPreset()],
			platform,
			mockHandler: () => okResponse('done'),
		})
		const session = await harness.createSession('test')
		const agentId = session.getEntryAgentId()!

		await session.sendMessage('hello')

		// Nothing ran: the delay is held by the host, not by a timer in this process.
		const key = agentWakeKey(session.sessionId, agentId, 'debounce')
		expect(scheduler.armed.get(key)).toBe(0)
		expect(harness.llmProvider.getCallCount()).toBe(0)

		scheduler.armed.clear()
		await harness.sessionManager.dispatchWake(key)

		expect(harness.llmProvider.getCallCount()).toBe(1)
		// The re-entrancy trap: a resumed debounce must not arm the same wake again.
		expect(scheduler.armed.has(key)).toBe(false)

		await harness.shutdown()
	})

	it('boots the session and runs the turn when the wake lands in a fresh process', async () => {
		const eventStore = new MemoryEventStore()
		const armed = recordingPlatform()

		// Process 1: arms the wake, never gets to deliver it (eviction).
		const first = new TestHarness({
			presets: [createTestPreset()],
			platform: armed.platform,
			eventStore,
			mockHandler: () => okResponse('done'),
		})
		const session = await first.createSession('test')
		const sessionId = session.sessionId
		const agentId = session.getEntryAgentId()!
		await session.sendMessage('hello')

		const key = agentWakeKey(sessionId, agentId, 'debounce')
		expect(armed.scheduler.armed.has(key)).toBe(true)
		expect(first.llmProvider.getCallCount()).toBe(0)
		await first.shutdown()

		// Process 2: same event log, nothing in memory — the key is the only input.
		const delivered = recordingPlatform()
		const second = new TestHarness({
			presets: [createTestPreset()],
			platform: delivered.platform,
			eventStore,
			mockHandler: () => okResponse('done'),
		})

		await second.sessionManager.dispatchWake(key)

		const reopened = await second.openSession(sessionId)
		await reopened.waitForIdle()
		expect(second.llmProvider.getCallCount()).toBeGreaterThan(0)
		expect(reopened.state.agents.get(agentId)!.conversationHistory.some(
			(m) => m.role === 'assistant',
		)).toBe(true)

		await second.shutdown()
	})

	it('hands a due retry wake back to normal scheduling', async () => {
		const { platform, scheduler } = recordingPlatform()
		const preset = createTestPreset()
		// Long enough that the backoff is still outstanding when the test looks.
		preset.orchestrator.errorResumeBackoff = { baseDelayMs: 30_000 }

		let calls = 0
		const harness = new TestHarness({
			presets: [preset],
			platform,
			mockHandler: () => {
				calls++
				if (calls === 1) throw { type: 'invalid_request', message: 'nope' }
				return okResponse('done')
			},
		})
		const session = await harness.createSession('test')
		const agentId = session.getEntryAgentId()!
		const debounceKey = agentWakeKey(session.sessionId, agentId, 'debounce')
		const retryKey = agentWakeKey(session.sessionId, agentId, 'retry')

		// First turn fails permanently — the agent lands in 'errored'.
		await session.sendMessage('hello')
		await harness.sessionManager.dispatchWake(debounceKey)
		expect(session.state.agents.get(agentId)!.status).toBe('errored')

		// A new message makes it resumable, but only once the backoff elapses.
		await session.sendMessage('still there?')
		await harness.sessionManager.dispatchWake(debounceKey)
		expect(scheduler.armed.get(retryKey)).toBeGreaterThan(25_000)

		// Delivering the retry wake re-enters scheduling rather than running inference
		// directly — continue() re-checks the remaining backoff.
		scheduler.armed.clear()
		await harness.sessionManager.dispatchWake(retryKey)
		expect(scheduler.armed.has(debounceKey)).toBe(true)

		await harness.shutdown()
	})

	it('is a no-op for a wake whose session is gone', async () => {
		const { platform } = recordingPlatform()
		const harness = new TestHarness({ presets: [createTestPreset()], platform })

		await harness.sessionManager.dispatchWake(
			agentWakeKey(SessionId('never-existed'), AgentId('orchestrator_1'), 'debounce'),
		)

		await harness.shutdown()
	})

	it('is a no-op for a wake whose agent is gone', async () => {
		const { platform } = recordingPlatform()
		const harness = new TestHarness({
			presets: [createTestPreset()],
			platform,
			mockHandler: () => okResponse('done'),
		})
		const session = await harness.createSession('test')

		await harness.sessionManager.dispatchWake(
			agentWakeKey(session.sessionId, AgentId('ghost_9'), 'debounce'),
		)

		expect(harness.llmProvider.getCallCount()).toBe(0)

		await harness.shutdown()
	})

	it('ignores a key it did not mint', async () => {
		const { platform } = recordingPlatform()
		const harness = new TestHarness({ presets: [createTestPreset()], platform })

		await harness.sessionManager.dispatchWake('not-a-wake-key')
		await harness.sessionManager.dispatchWake('services:s1:restart')

		await harness.shutdown()
	})
})
