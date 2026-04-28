import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ModelId } from '~/core/llm/schema.js'
import { SessionId } from '~/core/sessions/schema.js'
import { sessionEvents } from '~/core/sessions/state.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

describe('core: session lifecycle', () => {
	it('create session → session_created event emitted', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		})

		const session = await harness.createSession('test')

		const events = await session.getEventsByType(sessionEvents, 'session_created')
		expect(events).toHaveLength(1)
		expect(events[0].presetId).toBe('test')

		await harness.shutdown()
	})

	it('create session → orchestrator agent spawned automatically', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		})

		const session = await harness.createSession('test')

		const spawnEvents = await session.getEventsByType(agentEvents, 'agent_spawned')
		expect(spawnEvents.length).toBeGreaterThanOrEqual(1)

		// The orchestrator should be the entry agent
		const entryAgentId = session.getEntryAgentId()
		expect(entryAgentId).not.toBeNull()

		const agentState = session.state.agents.get(entryAgentId!)
		expect(agentState).toBeDefined()

		await harness.shutdown()
	})

	it('create session with communicator config → both communicator and orchestrator spawned', async () => {
		const harness = new TestHarness({
			presets: [{
				id: 'test-comm',
				name: 'Test with communicator',
				orchestrator: {
					system: 'Orchestrator.',
					model: ModelId('mock'),
					tools: [],
					agents: [],
					debounceMs: 0,
				},
				communicator: {
					system: 'Communicator.',
					model: ModelId('mock'),
					debounceMs: 0,
				},
				agents: [],
			}],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		})

		const session = await harness.createSession('test-comm')

		const spawnEvents = await session.getEventsByType(agentEvents, 'agent_spawned')
		// Should have both communicator and orchestrator
		expect(spawnEvents.length).toBeGreaterThanOrEqual(2)

		// Entry agent should be the communicator
		const entryAgentId = session.getEntryAgentId()
		expect(entryAgentId).not.toBeNull()

		// Both agents should exist in state
		expect(session.state.agents.size).toBeGreaterThanOrEqual(2)

		await harness.shutdown()
	})

	it('close session → session_closed event → status becomes closed', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Hi')

		await session.close()

		// Reload the session to check state
		const reloaded = await harness.sessionManager.getSession(session.sessionId)
		expect(reloaded.ok).toBe(true)
		if (reloaded.ok) {
			expect(reloaded.value.state.status).toBe('closed')

			const closedEvents = await harness.eventStore.getEventsByType(session.sessionId, 'session_closed')
			expect(closedEvents).toHaveLength(1)
		}

		await harness.shutdown()
	})

	it('reopen session → session_reopened event → agents can process again', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Hi')

		// Close
		await session.close()

		// Reopen via plugin method (need to reload first)
		const reloaded = await harness.sessionManager.getSession(session.sessionId)
		expect(reloaded.ok).toBe(true)
		if (reloaded.ok) {
			const reopenResult = await reloaded.value.callPluginMethod('sessions.reopen', {})
			expect(reopenResult.ok).toBe(true)

			const reopenedEvents = await harness.eventStore.getEventsByType(session.sessionId, 'session_reopened')
			expect(reopenedEvents).toHaveLength(1)

			// Session should be active again
			expect(reloaded.value.state.status).toBe('active')
		}

		await harness.shutdown()
	})

	it('session state reconstructed correctly from events', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Hello')

		const originalState = session.state
		const originalAgentCount = originalState.agents.size
		const originalPresetId = originalState.presetId

		// Reload session from event store (simulates restart)
		const reloaded = await harness.sessionManager.getSession(session.sessionId)
		expect(reloaded.ok).toBe(true)
		if (reloaded.ok) {
			const reloadedState = reloaded.value.state
			expect(reloadedState.presetId).toBe(originalPresetId)
			expect(reloadedState.agents.size).toBe(originalAgentCount)
			expect(reloadedState.status).toBe('active')
		}

		await harness.shutdown()
	})

	it('fork session → new session with events up to fork point, independent processing', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Message 1')
		await session.sendAndWaitForIdle('Message 2')

		const originalEvents = await session.getEvents()
		// Fork at roughly half the events
		const forkIndex = Math.floor(originalEvents.length / 2)

		const forkResult = await harness.sessionManager.callManagerMethod('sessions.fork', {
			sessionId: String(session.sessionId),
			eventIndex: forkIndex,
		})

		expect(forkResult.ok).toBe(true)
		if (forkResult.ok) {
			expect(forkResult.value).toMatchObject({ sessionId: expect.any(String) })
		}

		if (forkResult.ok && typeof forkResult.value === 'object' && forkResult.value !== null && 'sessionId' in forkResult.value) {
			const forkedSessionId = SessionId(String(forkResult.value.sessionId))

			// Forked session should have fewer events than the original
			const forkedEvents = await harness.eventStore.load(forkedSessionId)
			expect(forkedEvents.length).toBeLessThan(originalEvents.length)

			// Original session should be unaffected
			const originalEventsAfter = await session.getEvents()
			expect(originalEventsAfter.length).toBe(originalEvents.length)
		}

		await harness.shutdown()
	})
})
