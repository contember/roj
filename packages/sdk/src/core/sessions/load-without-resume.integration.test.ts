import { afterEach, describe, expect, it } from 'bun:test'
import type { AgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import type { MemoryEventStore } from '~/core/events/memory.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

const harnesses: TestHarness[] = []
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.shutdown()
})

function harness(eventStore?: MemoryEventStore): TestHarness {
	const result = new TestHarness({ presets: [createTestPreset()], eventStore })
	harnesses.push(result)
	return result
}

/**
 * A persisted session whose entry agent holds an unanswered message, as a runtime stopped
 * mid-work leaves it. Paused while the message lands, then resumed in the log alone, so no
 * runtime ever answered it.
 */
async function interruptedSession(): Promise<{ eventStore: MemoryEventStore; sessionId: SessionId; agentId: AgentId }> {
	const source = harness()
	const session = await source.createSession('test')
	const agentId = session.getEntryAgentId()
	if (!agentId) throw new Error('Expected an entry agent')
	await session.pauseAgent(agentId)
	await session.sendMessage('Rebuild the site')
	await source.eventStore.append(session.sessionId, withSessionId(session.sessionId, agentEvents.create('agent_resumed', { agentId })))
	await source.shutdown()
	return { eventStore: source.eventStore, sessionId: session.sessionId, agentId }
}

async function agentStatus(owner: TestHarness, sessionId: SessionId, agentId: AgentId): Promise<string | undefined> {
	const session = await owner.sessionManager.getSession(sessionId)
	if (!session.ok) throw new Error(`getSession failed: ${session.error.message}`)
	return session.value.state.agents.get(agentId)?.status
}

const waitUntil = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
		await Bun.sleep(5)
	}
}

describe('loadAllSessions without resume', () => {
	it('resumes interrupted work by default, as a restart recovery', async () => {
		const { eventStore } = await interruptedSession()
		const restarted = harness(eventStore)
		await restarted.sessionManager.loadAllSessions()
		await waitUntil(() => restarted.llmProvider.getCallCount() === 1)
	})

	it('pauses an agent with interrupted work instead of running it', async () => {
		const { eventStore, sessionId, agentId } = await interruptedSession()
		const restored = harness(eventStore)
		await restored.sessionManager.loadAllSessions({ resume: false })
		await Bun.sleep(50)
		expect(restored.llmProvider.getCallCount()).toBe(0)
		expect(await agentStatus(restored, sessionId, agentId)).toBe('paused')
		const pauses = (await eventStore.load(sessionId)).filter(event => event.type === 'agent_paused')
		expect(pauses.at(-1)).toMatchObject({ agentId, reason: 'manual' })
	})

	it('keeps the agent paused through a later load, until it is resumed', async () => {
		const { eventStore, sessionId, agentId } = await interruptedSession()
		await harness(eventStore).sessionManager.loadAllSessions({ resume: false })

		const later = harness(eventStore)
		await later.sessionManager.loadAllSessions()
		await Bun.sleep(50)
		expect(later.llmProvider.getCallCount()).toBe(0)
		expect(await agentStatus(later, sessionId, agentId)).toBe('paused')

		const session = await later.sessionManager.getSession(sessionId)
		if (!session.ok) throw new Error(session.error.message)
		expect((await session.value.resumeAgent(agentId)).ok).toBe(true)
		await waitUntil(() => later.llmProvider.getCallCount() === 1)
	})

	it('leaves an agent that only waits for input able to answer', async () => {
		const source = harness()
		const idle = await source.createSession('test')
		await idle.sendAndWaitForIdle('Hello')
		const agentId = idle.getEntryAgentId()
		if (!agentId) throw new Error('Expected an entry agent')
		await source.shutdown()

		const restored = harness(source.eventStore)
		await restored.sessionManager.loadAllSessions({ resume: false })
		expect(await agentStatus(restored, idle.sessionId, agentId)).not.toBe('paused')
		const reopened = await restored.openSession(idle.sessionId)
		await reopened.sendAndWaitForIdle('Change the title')
		expect(restored.llmProvider.getCallCount()).toBe(1)
	})
})
