import { describe, expect, it } from 'bun:test'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { definePlugin, Ok, selectSessionStats, sessionStatsPlugin, type SessionStatsState, z } from '~/index.js'
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

	it('includes session stats by default and exposes plugin state', async () => {
		expect(sessionStatsPlugin.name).toBe('session-stats')

		const harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withFixedResponse({
				content: 'Done',
				toolCalls: [],
				metrics: MockLLMProvider.defaultMetricsWithCost(1.25),
			}),
			// Passing a default plugin explicitly should not register it twice.
			systemPlugins: [sessionStatsPlugin],
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Test')

		const stats = session.getPluginState<SessionStatsState>('sessionStats')
		expect(stats?.llmCalls).toBe(1)
		expect(stats?.totalCost).toBe(1.25)
		expect(selectSessionStats(session.state).totalCost).toBe(1.25)

		await harness.shutdown()
	})

	it('callPluginMethod can pass caller context', async () => {
		const callerPlugin = definePlugin('caller')
			.method('whoami', {
				input: z.object({}),
				output: z.object({ source: z.string() }),
				handler: async ctx => Ok({ source: ctx.caller.source }),
			})
			.build()

		const harness = new TestHarness({
			presets: [createTestPreset()],
			systemPlugins: [callerPlugin],
		})

		const session = await harness.createSession('test')
		const result = await session.callPluginMethod('caller.whoami', {}, { caller: { source: 'system', meta: {} } })

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value).toEqual({ source: 'system' })
		}

		await harness.shutdown()
	})
})
