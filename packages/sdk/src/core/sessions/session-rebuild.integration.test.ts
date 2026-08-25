/**
 * A rebuilt runtime must still pick up work that arrived while it was gone.
 *
 * Characterisation, not a fix: moving the error-retry lease inside its timer
 * callback made a session evictable mid-backoff, which raised the question of
 * whether anything re-arms an agent after the rebuild. It does — these tests
 * pin that down so it cannot regress silently. The mail is appended straight to
 * the store with no runtime loaded, so no in-process scheduling can be what
 * resumes the agent; the second test guards the other direction, that waking
 * the runtime does not mean running every agent in it.
 */
import { describe, expect, it } from 'bun:test'
import { withSessionId } from '~/core/events/test-helpers.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { getEntryAgentId } from '~/core/sessions/state.js'
import { generateMessageId } from '~/plugins/mailbox/schema.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import type { AgentId } from '~/core/agents/schema.js'
import type { SessionId } from './schema.js'

const reply = (content: string) => ({
	content,
	toolCalls: [],
	finishReason: 'stop' as const,
	metrics: MockLLMProvider.defaultMetrics(),
})

const waitForEviction = async (harness: TestHarness): Promise<void> => {
	const deadline = Date.now() + 5_000
	while (Date.now() < deadline && harness.sessionManager.getRuntimeCacheStats().loadedSessionCount > 0) {
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
}

/** Append mail the way another process would: straight to the log, with no runtime loaded. */
const appendMailOutOfBand = async (
	harness: TestHarness,
	sessionId: SessionId,
	toAgentId: AgentId,
	content: string,
): Promise<void> => {
	const sequence = 1_000
	await harness.eventStore.append(sessionId, withSessionId(
		sessionId,
		mailboxEvents.create('mailbox_message', {
			toAgentId,
			sequence,
			message: {
				id: generateMessageId(sequence),
				from: 'user',
				content,
				timestamp: Date.now(),
				consumed: false,
			},
		}),
	))
}

describe('session rebuild', () => {
	it('resumes an agent that still has unconsumed mail when the runtime is rebuilt', async () => {
		let calls = 0
		const harness = new TestHarness({
			sessionIdleTimeoutMs: 150,
			presets: [createTestPreset()],
			mockHandler: () => {
				calls++
				return reply('ok')
			},
		})

		try {
			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')
			const agentId = getEntryAgentId(session.state)
			if (!agentId) throw new Error('Session has no entry agent')
			const callsBeforeEviction = calls

			await waitForEviction(harness)
			await appendMailOutOfBand(harness, session.sessionId, agentId, 'Work queued while you were gone')

			const reopened = await harness.openSession(session.sessionId)
			await reopened.waitForIdle({ timeoutMs: 5_000 })

			// Nothing in-process scheduled this agent — only the rebuild could have.
			expect(calls).toBeGreaterThan(callsBeforeEviction)
			// The real observable: the queued mail was actually taken, not merely present.
			expect(await reopened.getEventsByType('mailbox_consumed')).not.toHaveLength(0)
		} finally {
			await harness.shutdown()
		}
	})

	it('leaves an agent with nothing queued alone after a rebuild', async () => {
		let calls = 0
		const harness = new TestHarness({
			sessionIdleTimeoutMs: 150,
			presets: [createTestPreset()],
			mockHandler: () => {
				calls++
				return reply('ok')
			},
		})

		try {
			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')
			const callsBeforeEviction = calls

			await waitForEviction(harness)

			const reopened = await harness.openSession(session.sessionId)
			await reopened.waitForIdle({ timeoutMs: 5_000 })

			// Waking every agent on rebuild must not mean running every agent.
			expect(calls).toBe(callsBeforeEviction)
		} finally {
			await harness.shutdown()
		}
	})
})
