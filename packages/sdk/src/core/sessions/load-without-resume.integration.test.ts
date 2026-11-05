import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import type { AgentId } from '~/core/agents/schema.js'
import { ValidationErrors } from '~/core/errors.js'
import { agentEvents } from '~/core/agents/state.js'
import { MemoryEventStore } from '~/core/events/memory.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { DomainEvent } from '~/core/events/types.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { Session } from '~/core/sessions/session.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { Err } from '~/lib/utils/result.js'
import { createTestPreset, TestHarness, type TestSession } from '~/testing/index.js'

const harnesses: TestHarness[] = []
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.shutdown()
})

function harness(eventStore?: MemoryEventStore, llmProvider?: MockLLMProvider): TestHarness {
	const preset = createTestPreset({ agents: [{ name: 'child', system: 'Finish the task', tools: [], agents: [] }] })
	const result = new TestHarness({ presets: [preset], eventStore, llmProvider })
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

/** Gives an agent an unanswered message the way `interruptedSession` does: sent while paused, resumed in the log alone. */
async function leaveUnanswered(owner: TestHarness, session: TestSession, agentId: AgentId, content: string): Promise<void> {
	await session.pauseAgent(agentId)
	await session.sendMessageToAgent(agentId, content)
	await owner.eventStore.append(session.sessionId, withSessionId(session.sessionId, agentEvents.create('agent_resumed', { agentId })))
}

async function liveSession(owner: TestHarness, sessionId: SessionId): Promise<Session> {
	const session = await owner.sessionManager.getSession(sessionId)
	if (!session.ok) throw new Error(`getSession failed: ${session.error.message}`)
	return session.value
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
		expect(pauses.at(-1)).toMatchObject({ agentId, reason: 'manual', resumeOnInput: true })
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

	it('resumes a held agent when its user writes to it, and it answers the new message', async () => {
		const { eventStore, sessionId, agentId } = await interruptedSession()
		const restored = harness(eventStore)
		await restored.sessionManager.loadAllSessions({ resume: false })

		const reopened = await restored.openSession(sessionId)
		await reopened.sendMessage('Change the title')
		await waitUntil(() => restored.llmProvider.getCallCount() === 1)
		expect(JSON.stringify(restored.llmProvider.getLastRequest()?.messages)).toContain('Change the title')
		expect(await agentStatus(restored, sessionId, agentId)).not.toBe('paused')
	})

	it('resumes every held agent in the session when its user writes to one', async () => {
		const source = harness()
		const session = await source.createSession('test')
		const entryId = session.getEntryAgentId()
		if (!entryId) throw new Error('Expected an entry agent')
		const loaded = await source.sessionManager.getSession(session.sessionId)
		if (!loaded.ok) throw new Error(loaded.error.message)
		const spawned = await loaded.value.spawnAgentManually('child', entryId, 'Start the task')
		if (!spawned.ok) throw new Error(spawned.error.message)
		const childId = spawned.value
		await waitUntil(() => source.llmProvider.getCallCount() === 1)
		await leaveUnanswered(source, session, childId, 'Finish the old task')
		await leaveUnanswered(source, session, entryId, 'Rebuild the site')
		await source.shutdown()

		const restored = harness(source.eventStore)
		await restored.sessionManager.loadAllSessions({ resume: false })
		const reopened = await restored.openSession(session.sessionId)
		await reopened.sendMessage('Change the title')
		await waitUntil(() => restored.llmProvider.getCallCount() >= 2)
		expect(await agentStatus(restored, session.sessionId, childId)).not.toBe('paused')
		expect(await agentStatus(restored, session.sessionId, entryId)).not.toBe('paused')
		const requests = JSON.stringify(restored.llmProvider.getCallHistory().map(request => request.messages))
		expect(requests).toContain('Finish the old task')
	})

	it('leaves an agent paused by hand paused when the hold is released', async () => {
		const source = harness()
		const session = await source.createSession('test')
		const entryId = session.getEntryAgentId()
		if (!entryId) throw new Error('Expected an entry agent')
		const spawned = await (await liveSession(source, session.sessionId)).spawnAgentManually('child', entryId, 'Start the task')
		if (!spawned.ok) throw new Error(spawned.error.message)
		await waitUntil(() => source.llmProvider.getCallCount() === 1)
		await leaveUnanswered(source, session, entryId, 'Rebuild the site')
		await session.pauseAgent(spawned.value)
		await source.shutdown()

		const restored = harness(source.eventStore)
		await restored.sessionManager.loadAllSessions({ resume: false })
		const reopened = await restored.openSession(session.sessionId)
		await reopened.sendMessage('Change the title')
		await waitUntil(() => restored.llmProvider.getCallCount() === 1)
		await Bun.sleep(50)
		expect(await agentStatus(restored, session.sessionId, spawned.value)).toBe('paused')
	})

	it('leaves an agent paused by hand paused when its user writes to it', async () => {
		const owner = harness()
		const session = await owner.createSession('test')
		const agentId = session.getEntryAgentId()
		if (!agentId) throw new Error('Expected an entry agent')
		await session.pauseAgent(agentId)

		await session.sendMessage('Change the title')
		await Bun.sleep(50)
		expect(owner.llmProvider.getCallCount()).toBe(0)
		expect(await agentStatus(owner, session.sessionId, agentId)).toBe('paused')
	})

	it('does not wake an idle parent by holding its child', async () => {
		const source = harness()
		const session = await source.createSession('test')
		const entryId = session.getEntryAgentId()
		if (!entryId) throw new Error('Expected an entry agent')
		const spawned = await (await liveSession(source, session.sessionId)).spawnAgentManually('child', entryId, 'Start the task')
		if (!spawned.ok) throw new Error(spawned.error.message)
		await session.waitForIdle()
		const before = source.llmProvider.getCallCount()
		await leaveUnanswered(source, session, spawned.value, 'Finish the old task')
		// The parent answers the manual pause's notice here, so it is idle when the session is restored.
		await waitUntil(() => source.llmProvider.getCallCount() === before + 1)
		await source.shutdown()

		const restored = harness(source.eventStore)
		await restored.sessionManager.loadAllSessions({ resume: false })
		await Bun.sleep(50)
		expect(restored.llmProvider.getCallCount()).toBe(0)
		expect(await agentStatus(restored, session.sessionId, spawned.value)).toBe('paused')
	})

	it('holds the work on the next load when the hold failed', async () => {
		const { eventStore, sessionId, agentId } = await interruptedSession()
		const restored = harness(eventStore)
		spyOn(Session.prototype, 'pauseAgentsWithWork').mockImplementationOnce(async () => Err(ValidationErrors.invalid('store unavailable')))
		await restored.sessionManager.loadAllSessions({ resume: false })

		expect(await agentStatus(restored, sessionId, agentId)).toBe('paused')
		await Bun.sleep(50)
		expect(restored.llmProvider.getCallCount()).toBe(0)
	})

	it('resumes a held agent on the retry of a delivery whose resume failed', async () => {
		const { eventStore, sessionId, agentId } = await interruptedSession()
		const restored = harness(eventStore)
		await restored.sessionManager.loadAllSessions({ resume: false })
		const session = await liveSession(restored, sessionId)
		const send = () => session.callPluginMethod('user-chat.sendMessage', { sessionId, agentId, content: 'Change the title', deliveryId: 'd1' })

		spyOn(Session.prototype, 'resumeAgent').mockImplementationOnce(async () => Err(ValidationErrors.invalid('runtime parking')))
		expect((await send()).ok).toBe(false)
		expect((await send()).ok).toBe(true)
		await waitUntil(() => restored.llmProvider.getCallCount() === 1)
	})

	/** A restored session whose entry agent is idle and whose child is held. */
	async function heldChildSession(
		restoredLlm?: (childId: AgentId) => MockLLMProvider,
	): Promise<{ restored: TestHarness; session: Session; sessionId: SessionId; entryId: AgentId; childId: AgentId }> {
		const source = harness()
		const created = await source.createSession('test')
		const entryId = created.getEntryAgentId()
		if (!entryId) throw new Error('Expected an entry agent')
		const spawned = await (await liveSession(source, created.sessionId)).spawnAgentManually('child', entryId, 'Start the task')
		if (!spawned.ok) throw new Error(spawned.error.message)
		await created.waitForIdle()
		const before = source.llmProvider.getCallCount()
		await leaveUnanswered(source, created, spawned.value, 'Finish the old task')
		// The parent answers the manual pause's notice here, so it is idle when the session is restored.
		await waitUntil(() => source.llmProvider.getCallCount() === before + 1)
		await source.shutdown()

		const restored = harness(source.eventStore, restoredLlm?.(spawned.value))
		await restored.sessionManager.loadAllSessions({ resume: false })
		const session = await liveSession(restored, created.sessionId)
		return { restored, session, sessionId: created.sessionId, entryId, childId: spawned.value }
	}

	it('does not resume again a held agent resumed and paused by hand during the release', async () => {
		let onResumed: (agentId: string) => Promise<void> | void = () => {}
		class ResumeHookedStore extends MemoryEventStore {
			override async append(sessionId: SessionId, event: DomainEvent): Promise<void> {
				await super.append(sessionId, event)
				if (event.type === 'agent_resumed' && 'agentId' in event) await onResumed(String(event.agentId))
			}
		}
		const source = harness(new ResumeHookedStore())
		const created = await source.createSession('test')
		const entryId = created.getEntryAgentId()
		if (!entryId) throw new Error('Expected an entry agent')
		const owner = await liveSession(source, created.sessionId)
		const first = await owner.spawnAgentManually('child', entryId, 'Start the first task')
		const second = await owner.spawnAgentManually('child', entryId, 'Start the second task')
		if (!first.ok || !second.ok) throw new Error('spawn failed')
		await created.waitForIdle()
		await leaveUnanswered(source, created, first.value, 'Finish the first task')
		await leaveUnanswered(source, created, second.value, 'Finish the second task')
		await leaveUnanswered(source, created, entryId, 'Rebuild the site')
		await source.shutdown()

		const restored = harness(source.eventStore)
		await restored.sessionManager.loadAllSessions({ resume: false })
		const session = await liveSession(restored, created.sessionId)
		let byHand: Promise<unknown> = Promise.resolve()
		let trigger = true
		onResumed = async (agentId) => {
			if (agentId === entryId && trigger) {
				trigger = false
				byHand = session.resumeAgent(second.value).then(() => session.pauseAgent(second.value))
			}
			// Slows the loop, so the manual pause lands before it reaches the second child.
			if (agentId === first.value) await Bun.sleep(100)
		}
		const restoredAt = (await source.eventStore.load(created.sessionId)).length
		const sent = await session.callPluginMethod('user-chat.sendMessage', { sessionId: created.sessionId, agentId: entryId, content: 'Change the title' })
		expect(sent.ok).toBe(true)
		expect(await byHand).toMatchObject({ ok: true })
		const resumes = (await source.eventStore.load(created.sessionId)).slice(restoredAt).flatMap(event =>
			event.type === 'agent_resumed' && 'agentId' in event ? [event.agentId] : []
		)
		// The second child's one resume is the manual one; the release skips it once it is paused by hand.
		expect(resumes.filter(agentId => agentId === second.value)).toHaveLength(1)
		expect(resumes).toContain(first.value)
	})

	it('answers a retried delivery whose release failed on another agent', async () => {
		const { restored, session, sessionId, entryId } = await heldChildSession()
		const send = () => session.callPluginMethod('user-chat.sendMessage', { sessionId, agentId: entryId, content: 'Change the title', deliveryId: 'd1' })

		spyOn(Session.prototype, 'resumeAgent').mockImplementationOnce(async () => Err(ValidationErrors.invalid('runtime parking')))
		expect((await send()).ok).toBe(false)
		expect((await send()).ok).toBe(true)
		await waitUntil(() => restored.llmProvider.getCallHistory().some(request => JSON.stringify(request.messages).includes('Change the title')))
	})

	it('keeps a held agent paused on a host notice, and it reads the notice once its user writes', async () => {
		const { eventStore, sessionId, agentId } = await interruptedSession()
		const restored = harness(eventStore)
		await restored.sessionManager.loadAllSessions({ resume: false })
		const session = await liveSession(restored, sessionId)

		const notice = await session.callPluginMethod('user-chat.sendMessage', { sessionId, agentId, content: 'The rebase conflicted', keepHold: true })
		expect(notice.ok).toBe(true)
		await Bun.sleep(50)
		expect(restored.llmProvider.getCallCount()).toBe(0)
		expect(await agentStatus(restored, sessionId, agentId)).toBe('paused')

		const reopened = await restored.openSession(sessionId)
		await reopened.sendMessage('Change the title')
		await waitUntil(() => restored.llmProvider.getCallCount() === 1)
		const request = JSON.stringify(restored.llmProvider.getLastRequest()?.messages)
		expect(request).toContain('The rebase conflicted')
		expect(request).toContain('Change the title')
	})

	it('keeps the hold on the retry of a host notice', async () => {
		const { eventStore, sessionId, agentId } = await interruptedSession()
		const restored = harness(eventStore)
		await restored.sessionManager.loadAllSessions({ resume: false })
		const session = await liveSession(restored, sessionId)
		const send = () => session.callPluginMethod('user-chat.sendMessage', { sessionId, agentId, content: 'The rebase conflicted', deliveryId: 'd1', keepHold: true })

		expect((await send()).ok).toBe(true)
		expect((await send()).ok).toBe(true)
		await Bun.sleep(50)
		expect(restored.llmProvider.getCallCount()).toBe(0)
		expect(await agentStatus(restored, sessionId, agentId)).toBe('paused')
	})

	it('answers a host notice to an agent that is not held, and keeps the rest held', async () => {
		const { restored, session, sessionId, entryId, childId } = await heldChildSession()

		const notice = await session.callPluginMethod('user-chat.sendMessage', { sessionId, agentId: entryId, content: 'The rebase conflicted', keepHold: true })
		expect(notice.ok).toBe(true)
		await waitUntil(() => restored.llmProvider.getCallHistory().some(request => JSON.stringify(request.messages).includes('The rebase conflicted')))
		await Bun.sleep(50)
		expect(await agentStatus(restored, sessionId, childId)).toBe('paused')
	})

	it('refuses an agent that answers a host notice its resume of a held child', async () => {
		const { restored, session, sessionId, entryId, childId } = await heldChildSession(childId => MockLLMProvider.withSequence([
			{ toolCalls: [{ id: ToolCallId('tc1'), name: 'resume_agent', input: { agentId: String(childId) } }] },
			{ content: 'Done', toolCalls: [] },
		]))

		const notice = await session.callPluginMethod('user-chat.sendMessage', { sessionId, agentId: entryId, content: 'The rebase conflicted', keepHold: true })
		expect(notice.ok).toBe(true)
		await waitUntil(() => restored.llmProvider.getCallCount() === 2)
		expect(JSON.stringify(restored.llmProvider.getLastRequest()?.messages)).toContain('it resumes when the user writes')
		expect(await agentStatus(restored, sessionId, childId)).toBe('paused')
	})

	it('conflicts on a retried delivery that changes keepHold, in flight or after', async () => {
		const { eventStore, sessionId, agentId } = await interruptedSession()
		const restored = harness(eventStore)
		await restored.sessionManager.loadAllSessions({ resume: false })
		const session = await liveSession(restored, sessionId)
		const send = (keepHold: boolean | undefined, deliveryId: string) =>
			session.callPluginMethod('user-chat.sendMessage', { sessionId, agentId, content: 'The rebase conflicted', deliveryId, keepHold })

		const [first, inFlight] = await Promise.all([send(true, 'd1'), send(undefined, 'd1')])
		expect(first.ok).toBe(true)
		expect(inFlight.ok ? undefined : inFlight.error.type).toBe('user_chat_delivery_conflict')
		const after = await send(undefined, 'd1')
		expect(after.ok ? undefined : after.error.type).toBe('user_chat_delivery_conflict')
		const flippedOn = await send(false, 'd2')
		expect(flippedOn.ok).toBe(true)
		const retried = await send(true, 'd2')
		expect(retried.ok ? undefined : retried.error.type).toBe('user_chat_delivery_conflict')
	})

	it('reports a session that failed to load, whose work it did not hold', async () => {
		const { eventStore, sessionId } = await interruptedSession()
		class FailingStore extends MemoryEventStore {
			override async load(id: SessionId): Promise<DomainEvent[]> {
				if (id === sessionId) throw new Error('unreadable log')
				return super.load(id)
			}
		}
		const failing = new FailingStore()
		for (const event of await eventStore.load(sessionId)) await failing.append(sessionId, event)
		const restored = harness(failing)

		const loaded = await restored.sessionManager.loadAllSessions({ resume: false })
		expect(loaded.failed).toEqual([sessionId])
		expect((await harness(eventStore).sessionManager.loadAllSessions({ resume: false })).failed).toEqual([])
	})

	it('releases the whole hold when its user answers an agent that was not held', async () => {
		const { restored, session, sessionId, entryId, childId } = await heldChildSession()

		const answered = await session.callPluginMethod('user-chat.answerQuestion', { agentId: entryId, questionId: 'm0', answer: 'Yes' })
		expect(answered.ok).toBe(true)
		expect(await agentStatus(restored, sessionId, childId)).not.toBe('paused')
	})

	it('resumes a held agent when its user answers it', async () => {
		const { eventStore, sessionId, agentId } = await interruptedSession()
		const restored = harness(eventStore)
		await restored.sessionManager.loadAllSessions({ resume: false })
		const session = await liveSession(restored, sessionId)

		const answered = await session.callPluginMethod('user-chat.answerQuestion', { agentId, questionId: 'm0', answer: 'Yes' })
		expect(answered.ok).toBe(true)
		await waitUntil(() => restored.llmProvider.getCallCount() === 1)
	})

	it('accepts a message to a held agent that was rewound since', async () => {
		const { eventStore, sessionId, agentId } = await interruptedSession()
		await harness(eventStore).sessionManager.loadAllSessions({ resume: false })
		await eventStore.append(sessionId, withSessionId(sessionId, agentEvents.create('agent_conversation_spliced', { agentId, start: 0, deleteCount: 0 })))

		const later = harness(eventStore)
		const reopened = await later.openSession(sessionId)
		await reopened.sendMessage('Change the title')
		expect(await agentStatus(later, sessionId, agentId)).not.toBe('paused')
	})
})
