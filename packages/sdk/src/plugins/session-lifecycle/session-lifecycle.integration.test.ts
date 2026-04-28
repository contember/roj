import { describe, expect, it } from 'bun:test'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { SessionId } from '~/core/sessions/schema.js'
import { sessionEvents } from '~/core/sessions/state.js'
import { createMultiAgentPreset, createTestPreset, TestHarness } from '~/testing/index.js'

/** Extract object value from ok Result — asserts result.ok at runtime. */
function okValue(result: { ok: boolean; value?: unknown }): Record<string, unknown> {
	expect(result.ok).toBe(true)
	if (!result.ok || typeof result.value !== 'object' || result.value === null) {
		throw new Error('Expected ok result with object value')
	}
	return result.value as Record<string, unknown>
}

describe('session-lifecycle plugin', () => {
	// =========================================================================
	// sessions.create
	// =========================================================================

	describe('sessions.create', () => {
		it('create session → returns sessionId → session is active', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const result = await harness.sessionManager.callManagerMethod('sessions.create', {
				presetId: 'test',
			})

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.value).toMatchObject({ sessionId: expect.any(String) })
			}

			await harness.shutdown()
		})

		it('create with unknown presetId → error (preset_not_found)', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const result = await harness.sessionManager.callManagerMethod('sessions.create', {
				presetId: 'nonexistent-preset',
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.type).toBe('preset_not_found')
			}

			await harness.shutdown()
		})

		it('create with workspaceDir → stored in session state', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const result = await harness.sessionManager.callManagerMethod('sessions.create', {
				presetId: 'test',
				workspaceDir: '/tmp/test-workspace',
			})

			const data = okValue(result)
			const sessionResult = await harness.sessionManager.getSession(SessionId(String(data.sessionId)))
			expect(sessionResult.ok).toBe(true)
			if (sessionResult.ok) {
				expect(sessionResult.value.state.workspaceDir).toBe('/tmp/test-workspace')
			}

			await harness.shutdown()
		})
	})

	// =========================================================================
	// sessions.get
	// =========================================================================

	describe('sessions.get', () => {
		it('get existing session → returns correct fields', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			const result = await session.callPluginMethod('sessions.get', {})

			const data = okValue(result)
			expect(data).toMatchObject({
				sessionId: String(session.sessionId),
				presetId: 'test',
				status: 'active',
				createdAt: expect.any(Number),
				entryAgentId: expect.any(String),
			})
			expect(data.agentCount).toBeGreaterThanOrEqual(1)

			await harness.shutdown()
		})

		it('get non-existent session → error (session_not_found)', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const result = await harness.sessionManager.getSession(SessionId('nonexistent-id'))
			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.type).toBe('session_not_found')
			}

			await harness.shutdown()
		})

		it('get after close → status is closed, closedAt set', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			// Close the session via plugin method
			const closeResult = await session.callPluginMethod('sessions.close', {})
			expect(closeResult.ok).toBe(true)

			// Get session info — need to reload since close evicts from cache
			const sessionResult = await harness.sessionManager.getSession(session.sessionId)
			expect(sessionResult.ok).toBe(true)
			if (sessionResult.ok) {
				const reloaded = sessionResult.value
				const getResult = await reloaded.callPluginMethod('sessions.get', {})
				const data = okValue(getResult)
				expect(data).toMatchObject({
					status: 'closed',
					closedAt: expect.any(Number),
				})
			}

			await harness.shutdown()
		})
	})

	// =========================================================================
	// sessions.close
	// =========================================================================

	describe('sessions.close', () => {
		it('close active session → status becomes closed', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			expect(session.state.status).toBe('active')

			const result = await session.callPluginMethod('sessions.close', {})
			expect(result.ok).toBe(true)

			// State should reflect closed
			expect(session.state.status).toBe('closed')

			await harness.shutdown()
		})

		it('close already-closed session → error (session_closed)', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			// Close first time
			const first = await session.callPluginMethod('sessions.close', {})
			expect(first.ok).toBe(true)

			// Close again → error
			const second = await session.callPluginMethod('sessions.close', {})
			expect(second.ok).toBe(false)
			if (!second.ok) {
				expect(second.error.type).toBe('session_closed')
			}

			await harness.shutdown()
		})

		it('close → session_closed event emitted', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			await session.callPluginMethod('sessions.close', {})

			const events = await session.getEventsByType(sessionEvents, 'session_closed')
			expect(events).toHaveLength(1)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// sessions.reopen
	// =========================================================================

	describe('sessions.reopen', () => {
		it('reopen closed session → status becomes active', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			// Close then reopen
			await session.callPluginMethod('sessions.close', {})
			expect(session.state.status).toBe('closed')

			const result = await session.callPluginMethod('sessions.reopen', {})
			expect(result.ok).toBe(true)
			expect(session.state.status).toBe('active')

			await harness.shutdown()
		})

		it('reopen non-closed session → error (validation_error)', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			expect(session.state.status).toBe('active')

			const result = await session.callPluginMethod('sessions.reopen', {})
			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.type).toBe('validation_error')
			}

			await harness.shutdown()
		})

		it('reopen → session_reopened event emitted', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			await session.callPluginMethod('sessions.close', {})
			await session.callPluginMethod('sessions.reopen', {})

			const events = await session.getEventsByType(sessionEvents, 'session_reopened')
			expect(events).toHaveLength(1)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// sessions.list
	// =========================================================================

	describe('sessions.list', () => {
		it('list with no sessions → empty list, total: 0', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const result = await harness.sessionManager.callManagerMethod('sessions.list', {})

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.value).toMatchObject({ sessions: [], total: 0 })
			}

			await harness.shutdown()
		})

		it('list after creating sessions → returns all', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			await harness.createSession('test')
			await harness.createSession('test')

			const result = await harness.sessionManager.callManagerMethod('sessions.list', {})

			const data = okValue(result)
			expect(data.sessions).toHaveLength(2)
			expect(data.total).toBe(2)

			await harness.shutdown()
		})

		it('list with status: active → only active sessions', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session1 = await harness.createSession('test')
			await harness.createSession('test')

			// Close session1
			await session1.callPluginMethod('sessions.close', {})

			const result = await harness.sessionManager.callManagerMethod('sessions.list', {
				status: 'active',
			})

			const data = okValue(result)
			expect(data.total).toBe(1)
			expect(data.sessions).toHaveLength(1)
			expect(data).toMatchObject({
				sessions: [expect.objectContaining({ status: 'active' })],
			})

			await harness.shutdown()
		})

		it('list with limit and offset → pagination works', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			await harness.createSession('test')
			await harness.createSession('test')
			await harness.createSession('test')

			const result = await harness.sessionManager.callManagerMethod('sessions.list', {
				limit: 2,
				offset: 1,
			})

			const data = okValue(result)
			expect(data.total).toBe(3)
			expect(data.sessions).toHaveLength(2)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// sessions.getEvents
	// =========================================================================

	describe('sessions.getEvents', () => {
		it('get events for session → returns all events with total and lastIndex', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			const result = await session.callPluginMethod('sessions.getEvents', {})

			const data = okValue(result)
			expect(typeof data.total).toBe('number')
			expect(typeof data.lastIndex).toBe('number')
			expect(Array.isArray(data.events)).toBe(true)
			expect(data.total).toBeGreaterThan(0)

			await harness.shutdown()
		})

		it('filter by type: session_created → only session_created events', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			const result = await session.callPluginMethod('sessions.getEvents', {
				type: 'session_created',
			})

			const data = okValue(result)
			expect(data.total).toBe(1)
			expect(data.events).toHaveLength(1)
			expect(data).toMatchObject({
				events: [expect.objectContaining({ type: 'session_created' })],
			})

			await harness.shutdown()
		})

		it('filter by agentId → only events for that agent', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			const entryAgentId = session.getEntryAgentId()!

			const result = await session.callPluginMethod('sessions.getEvents', {
				agentId: String(entryAgentId),
			})

			const data = okValue(result)
			expect(data.total).toBeGreaterThan(0)
			// All returned events should have the correct agentId
			if (Array.isArray(data.events)) {
				for (const event of data.events) {
					expect(event).toMatchObject({ agentId: String(entryAgentId) })
				}
			}

			await harness.shutdown()
		})

		it('since parameter → only events after given index', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			// First, get all events to know the count
			const allData = okValue(await session.callPluginMethod('sessions.getEvents', {}))

			// Then get events since midpoint
			const midpoint = Math.floor(Number(allData.lastIndex) / 2)
			const sinceData = okValue(
				await session.callPluginMethod('sessions.getEvents', {
					since: midpoint,
				}),
			)

			// Should have fewer events than all
			expect(Number(sinceData.total)).toBeLessThan(Number(allData.total))

			await harness.shutdown()
		})

		it('limit → caps returned events', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			const result = await session.callPluginMethod('sessions.getEvents', {
				limit: 2,
			})

			const data = okValue(result)
			expect(data.events).toHaveLength(2)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// sessions.fork
	// =========================================================================

	describe('sessions.fork', () => {
		it('fork session at event index → new session created', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			const allEvents = await session.getEvents()

			const result = await harness.sessionManager.callManagerMethod('sessions.fork', {
				sessionId: String(session.sessionId),
				eventIndex: allEvents.length - 1,
			})

			const data = okValue(result)
			expect(data.sessionId).toBeDefined()
			expect(data.sessionId).not.toBe(String(session.sessionId))

			await harness.shutdown()
		})

		it('forked session has events up to fork point', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			const allEvents = await session.getEvents()
			const forkIndex = Math.min(3, allEvents.length - 1)

			const result = await harness.sessionManager.callManagerMethod('sessions.fork', {
				sessionId: String(session.sessionId),
				eventIndex: forkIndex,
			})

			const data = okValue(result)
			const forkedEvents = await harness.eventStore.load(SessionId(String(data.sessionId)))
			// Forked session should have events up to forkIndex + 1
			// (plus possible recovery events like session_restarted)
			expect(forkedEvents.length).toBeGreaterThanOrEqual(forkIndex + 1)

			await harness.shutdown()
		})

		it("forked session is independent (new events don't affect original)", async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			const originalEventsCount = (await session.getEvents()).length
			const allEvents = await session.getEvents()

			const result = await harness.sessionManager.callManagerMethod('sessions.fork', {
				sessionId: String(session.sessionId),
				eventIndex: allEvents.length - 1,
			})

			const data = okValue(result)
			const forkedSession = await harness.sessionManager.getSession(SessionId(String(data.sessionId)))
			expect(forkedSession.ok).toBe(true)

			// Send a message to the forked session — this creates new events only in forked
			if (forkedSession.ok) {
				await forkedSession.value.callPluginMethod('sessions.close', {})
			}

			// Original session should still have the same number of events
			const originalEventsAfter = await session.getEvents()
			expect(originalEventsAfter.length).toBe(originalEventsCount)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// presets.list
	// =========================================================================

	describe('presets.list', () => {
		it('list presets → returns all configured presets with id, name', async () => {
			const harness = new TestHarness({
				presets: [
					createTestPreset({ id: 'preset-a' }),
					createTestPreset({ id: 'preset-b' }),
				],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const result = await harness.sessionManager.callManagerMethod('presets.list', {})

			const data = okValue(result)
			expect(data.presets).toHaveLength(2)
			expect(data).toMatchObject({
				presets: expect.arrayContaining([
					expect.objectContaining({ id: 'preset-a', name: expect.any(String) }),
					expect.objectContaining({ id: 'preset-b', name: expect.any(String) }),
				]),
			})

			await harness.shutdown()
		})
	})

	// =========================================================================
	// presets.getAgents
	// =========================================================================

	describe('presets.getAgents', () => {
		it('get agents for session → returns agent definitions with spawnableBy info', async () => {
			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
					{ name: 'researcher', system: 'Research agent.', tools: [], agents: [] },
				])],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			const result = await harness.sessionManager.callManagerMethod('presets.getAgents', {
				sessionId: String(session.sessionId),
			})

			const data = okValue(result)
			expect(data.agents).toHaveLength(2)
			expect(data).toMatchObject({
				agents: expect.arrayContaining([
					expect.objectContaining({
						name: 'worker',
						spawnableBy: expect.arrayContaining(['orchestrator']),
						hasInputSchema: false,
					}),
					expect.objectContaining({
						name: 'researcher',
						spawnableBy: expect.arrayContaining(['orchestrator']),
					}),
				]),
			})

			await harness.shutdown()
		})
	})
})
