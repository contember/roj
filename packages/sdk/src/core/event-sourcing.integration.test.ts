import { describe, expect, it } from 'bun:test'
import { agentEvents } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { llmEvents } from '~/core/llm/state.js'
import { applyEvent } from '~/core/sessions/apply-event.js'
import { reconstructSessionState } from '~/core/sessions/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { toolEvents } from '~/core/tools/state.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

describe('core: event sourcing correctness', () => {
	it('all events from a full flow persisted in event store in correct order', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withSequence([
				{
					toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
				},
				{ content: 'Done', toolCalls: [] },
			]),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Hello')

		const events = await session.getEvents()

		// Should start with session_created
		expect(events[0].type).toBe('session_created')

		// Extract event types in order
		const types = events.map((e) => e.type)

		// session_created must come first
		expect(types.indexOf('session_created')).toBe(0)

		// agent_spawned after session_created
		expect(types.indexOf('agent_spawned')).toBeGreaterThan(types.indexOf('session_created'))

		// inference_started before inference_completed
		const inferStartIdx = types.indexOf('inference_started')
		const inferCompleteIdx = types.indexOf('inference_completed')
		expect(inferStartIdx).toBeGreaterThan(-1)
		expect(inferCompleteIdx).toBeGreaterThan(inferStartIdx)

		// tool_started before tool_completed
		const toolStartIdx = types.indexOf('tool_started')
		const toolCompleteIdx = types.indexOf('tool_completed')
		expect(toolStartIdx).toBeGreaterThan(-1)
		expect(toolCompleteIdx).toBeGreaterThan(toolStartIdx)

		// tool events between first and second inference cycles
		expect(toolStartIdx).toBeGreaterThan(inferCompleteIdx)

		await harness.shutdown()
	})

	it('session state after replay matches live state', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withSequence([
				{
					toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
				},
				{ content: 'Done', toolCalls: [] },
			]),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Hello')

		const liveState = session.state
		const events = await session.getEvents()

		// Replay state from events using the base reducer (core + mailbox)
		const replayedState = reconstructSessionState(events, applyEvent)

		expect(replayedState).not.toBeNull()
		expect(replayedState!.id).toEqual(liveState.id)
		expect(replayedState!.presetId).toBe(liveState.presetId)
		expect(replayedState!.status).toBe(liveState.status)
		expect(replayedState!.agents.size).toBe(liveState.agents.size)

		// Verify each agent's status matches
		for (const [agentId, liveAgent] of liveState.agents) {
			const replayedAgent = replayedState!.agents.get(agentId)
			expect(replayedAgent).toBeDefined()
			expect(replayedAgent!.status).toBe(liveAgent.status)
			expect(replayedAgent!.definitionName).toBe(liveAgent.definitionName)
			expect(replayedAgent!.conversationHistory.length).toBe(liveAgent.conversationHistory.length)
		}

		await harness.shutdown()
	})

	it('event types include expected core events from a full flow', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withSequence([
				{
					toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
				},
				{ content: 'Done', toolCalls: [] },
			]),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Hello')

		const events = await session.getEvents()
		const eventTypes = new Set(events.map((e) => e.type))

		// Core lifecycle events
		expect(eventTypes.has('session_created')).toBe(true)
		expect(eventTypes.has('agent_spawned')).toBe(true)

		// LLM events
		expect(eventTypes.has('inference_started')).toBe(true)
		expect(eventTypes.has('inference_completed')).toBe(true)

		// Tool events
		expect(eventTypes.has('tool_started')).toBe(true)
		expect(eventTypes.has('tool_completed')).toBe(true)

		// User chat events
		expect(eventTypes.has('user_chat_message_received')).toBe(true)

		await harness.shutdown()
	})

	it('event timestamps are monotonically increasing', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withSequence([
				{
					toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
				},
				{ content: 'Done', toolCalls: [] },
			]),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Hello')

		const events = await session.getEvents()

		for (let i = 1; i < events.length; i++) {
			expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp)
		}

		await harness.shutdown()
	})

	it('events have correct agentId references', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withSequence([
				{
					toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
				},
				{ content: 'Done', toolCalls: [] },
			]),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Hello')

		const entryAgentId = session.getEntryAgentId()!

		// All agent-scoped events should reference the entry agent
		const inferenceStarted = await session.getEventsByType(llmEvents, 'inference_started')
		const inferenceCompleted = await session.getEventsByType(llmEvents, 'inference_completed')
		const toolStarted = await session.getEventsByType(toolEvents, 'tool_started')
		const toolCompleted = await session.getEventsByType(toolEvents, 'tool_completed')
		const agentScopedEvents = [...inferenceStarted, ...inferenceCompleted, ...toolStarted, ...toolCompleted]

		expect(agentScopedEvents.length).toBeGreaterThan(0)
		for (const event of agentScopedEvents) {
			expect(event.agentId).toBe(entryAgentId)
		}

		// agent_spawned should also reference the correct agent
		const spawnedEvents = await session.getEventsByType(agentEvents, 'agent_spawned')
		expect(spawnedEvents.length).toBeGreaterThan(0)
		for (const e of spawnedEvents) {
			expect(session.state.agents.has(e.agentId)).toBe(true)
		}

		await harness.shutdown()
	})
})
