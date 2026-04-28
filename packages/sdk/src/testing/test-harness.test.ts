import { describe, expect, it } from 'bun:test'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createTestPreset, TestHarness } from './index.js'

describe('TestHarness', () => {
	it('sendMessage → tell_user → notification', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withSequence([
				{
					content: null,
					toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hello!' } }],
				},
				{ content: 'Done', toolCalls: [] },
			]),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Hi')

		const messages = harness.notifications.getAgentMessages()
		expect(messages).toHaveLength(1)
		expect(messages[0].content).toBe('Hello!')

		await harness.shutdown()
	})

	it('creates session with correct state', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
		})

		const session = await harness.createSession('test')

		expect(session.state.status).toBe('active')
		expect(session.state.presetId).toBe('test')
		expect(session.getEntryAgentId()).not.toBeNull()

		await harness.shutdown()
	})

	it('captures events from event store', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withFixedResponse({
				content: 'Done',
				toolCalls: [],
			}),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Test')

		const events = await session.getEvents()
		const sessionCreated = await session.getEventsByType('session_created')

		expect(events.length).toBeGreaterThan(0)
		expect(sessionCreated).toHaveLength(1)

		await harness.shutdown()
	})
})
