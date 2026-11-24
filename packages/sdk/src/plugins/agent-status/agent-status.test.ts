import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { AgentId } from '~/core/agents/schema.js'
import { agentStopSchema } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { llmEvents } from '~/core/llm/state.js'
import type { PluginNotification } from '~/core/plugins/plugin-builder.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { limitsGuardPlugin } from '~/plugins/limits-guard/plugin.js'
import { createMultiAgentPreset, createTestPreset, type TestSession, TestHarness } from '~/testing/index.js'
import { type AgentStoppedNotification, agentStatusPlugin } from './plugin.js'

type StatusPayload = { sessionId: string; agentId: string; status: string; definitionName?: string; timestamp: number }

const agentStatusNotifications = (session: TestSession): StatusPayload[] =>
	session.getNotifications()
		.filter((n: PluginNotification) => n.pluginName === 'agent-status' && n.type === 'agentStatus')
		.map((n) => n.payload as StatusPayload)

const agentStoppedNotifications = (session: TestSession): AgentStoppedNotification[] =>
	session.getNotifications()
		.filter((n: PluginNotification) => n.pluginName === 'agent-status' && n.type === 'agentStopped')
		.map((n) => n.payload as AgentStoppedNotification)

async function waitForAgentStatus(session: TestSession, agentId: AgentId, status: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const agentState = session.state.agents.get(agentId)
		if (agentState?.status === status) return
		await new Promise((r) => setTimeout(r, 10))
	}
	throw new Error(`waitForAgentStatus timed out after ${timeoutMs}ms (wanted ${status}) for agent ${agentId}`)
}

describe('agent-status plugin', () => {
	describe('agentStatus (existing behavior)', () => {
		it('emits thinking on start and idle on completion', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				systemPlugins: [agentStatusPlugin],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			await session.sendAndWaitForIdle('Hello')

			const statuses = agentStatusNotifications(session).map((p) => p.status)
			expect(statuses).toContain('thinking')
			expect(statuses).toContain('idle')

			// No abnormal-terminal notification for a normal completion.
			expect(agentStoppedNotifications(session)).toHaveLength(0)

			await harness.shutdown()
		})
	})

	describe('agentStopped on pause', () => {
		it('manual pause → agentStopped kind:paused reason:manual with message', async () => {
			let orchestratorCalls = 0
			const harness = new TestHarness({
				presets: [createMultiAgentPreset(
					[{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] }],
					{ orchestratorSystem: 'Orchestrator agent.' },
				)],
				systemPlugins: [agentStatusPlugin],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Work' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			// Manual pause via Session.pauseAgent — the real manual-pause API that
			// runs onPause hooks (agents.pause only emits the event, no hooks).
			const innerSession = (session as unknown as { session: { pauseAgent: (id: AgentId, message?: string) => Promise<{ ok: boolean }> } }).session
			const result = await innerSession.pauseAgent(AgentId('worker_1'), 'Pausing for review')
			expect(result.ok).toBe(true)

			const stopped = agentStoppedNotifications(session).filter((n) => n.agentId === 'worker_1')
			expect(stopped).toHaveLength(1)
			expect(stopped[0].kind).toBe('paused')
			expect(stopped[0].reason).toBe('manual')
			expect(stopped[0].message).toBe('Pausing for review')
			expect(stopped[0].definitionName).toBe('worker')
			expect(typeof stopped[0].timestamp).toBe('number')

			// idle agentStatus still emitted alongside.
			expect(agentStatusNotifications(session).some((p) => p.agentId === 'worker_1' && p.status === 'idle')).toBe(true)

			await harness.shutdown()
		})

		it('limits-guard hard limit → agentStopped kind:paused with reason and message', async () => {
			let inferenceCount = 0
			const harness = new TestHarness({
				presets: [createTestPreset({
					orchestratorSystem: 'Test agent.',
					orchestratorPlugins: [limitsGuardPlugin.configureAgent({ limits: { maxTurns: 2 } })],
				})],
				systemPlugins: [agentStatusPlugin, limitsGuardPlugin],
				mockHandler: () => {
					inferenceCount++
					return {
						content: null,
						toolCalls: [{ id: ToolCallId(`tc${inferenceCount}`), name: 'tell_user', input: { message: `Turn ${inferenceCount}` } }],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				},
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			await session.sendMessage('Start')
			await waitForAgentStatus(session, entryAgentId, 'paused')

			const stopped = agentStoppedNotifications(session).filter((n) => n.agentId === String(entryAgentId))
			expect(stopped.length).toBeGreaterThanOrEqual(1)
			expect(stopped[0].kind).toBe('paused')
			// limits-guard pauses via beforeInference {action:'pause'} → reason 'handler',
			// with the human-readable budget detail in `message`.
			expect(stopped[0].reason).toBe('handler')
			expect(stopped[0].message).toBeTruthy()

			await harness.shutdown()
		})
	})

	describe('agentStopped on error', () => {
		it('non-retryable LLM error → agentStopped kind:errored with message', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				systemPlugins: [agentStatusPlugin],
				llmProvider: MockLLMProvider.withError({
					type: 'invalid_request',
					message: 'Bad request',
					statusCode: 400,
					providerError: { statusCode: 400, body: '{"message":"Bad request"}' },
				}),
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			await session.sendMessage('Trigger error')
			await waitForAgentStatus(session, entryAgentId, 'errored')

			const stopped = agentStoppedNotifications(session).filter((n) => n.agentId === String(entryAgentId))
			expect(stopped).toHaveLength(1)
			expect(stopped[0].kind).toBe('errored')
			expect(stopped[0].reason).toBeUndefined()
			expect(stopped[0].message).toBe('Bad request')
			expect(stopped[0].inferenceFailure).toEqual({
				errorType: 'invalid_request',
				model: 'mock',
				providerError: { statusCode: 400, body: '{"message":"Bad request"}' },
			})
			expect(stopped[0].definitionName).toBeDefined()

			await harness.shutdown()
		})
	})

	describe('stopped agents in sessions.get', () => {
		const sessionInfoSchema = z.object({ stoppedAgents: z.array(agentStopSchema) })

		/** What a client reads when it (re)loads the page. */
		async function stoppedAgents(session: { callPluginMethod: (method: string, input: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }> }) {
			const result = await session.callPluginMethod('sessions.get', {})
			if (!result.ok) throw new Error(result.error.message)
			return sessionInfoSchema.parse(result.value).stoppedAgents
		}

		const withoutSession = ({ sessionId: _sessionId, ...stop }: AgentStoppedNotification) => stop

		const retryPreset = (baseDelayMs: number) => {
			const preset = createTestPreset()
			return { ...preset, orchestrator: { ...preset.orchestrator, errorResumeBackoff: { baseDelayMs, maxDelayMs: 60_000 } } }
		}

		it('lists an errored agent as its agentStopped notification reported it, across a server restart, until a turn commits', async () => {
			let failing = true
			const presets = [retryPreset(1)]
			const llmProvider = new MockLLMProvider(() => {
				if (failing) throw { type: 'invalid_request', message: 'Bad request', statusCode: 400, providerError: { statusCode: 400, body: '{"message":"Bad request"}' } }
				return { content: 'Answered', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			})
			const first = new TestHarness({ presets, systemPlugins: [agentStatusPlugin], llmProvider })
			const session = await first.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			await session.sendMessage('Trigger error')
			await waitForAgentStatus(session, entryAgentId, 'errored')

			const live = agentStoppedNotifications(session)
			expect(live).toHaveLength(1)
			const [failure] = await session.getEventsByType(llmEvents, 'inference_failed')
			const expected = [{ ...withoutSession(live[0]), timestamp: failure.timestamp }]
			expect(await stoppedAgents(session)).toEqual(expected)
			expect(expected[0].inferenceFailure).toEqual({ errorType: 'invalid_request', model: 'mock', providerError: { statusCode: 400, body: '{"message":"Bad request"}' } })
			await first.shutdown()

			// The restart resets the agent to pending, but nothing answered the message that failed.
			const restarted = new TestHarness({ presets, systemPlugins: [agentStatusPlugin], llmProvider, eventStore: first.eventStore })
			await restarted.sessionManager.loadAllSessions()
			const reloaded = await restarted.sessionManager.getSession(session.sessionId)
			if (!reloaded.ok) throw new Error(reloaded.error.message)
			expect(await stoppedAgents(reloaded.value)).toEqual(expected)

			failing = false
			const sent = await reloaded.value.callPluginMethod('user-chat.sendMessage', { content: 'Try again' })
			if (!sent.ok) throw new Error(sent.error.message)
			const deadline = Date.now() + 5_000
			while (reloaded.value.state.agents.get(entryAgentId)?.inferenceError !== undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
			expect(await stoppedAgents(reloaded.value)).toEqual([])

			await restarted.shutdown()
		})

		it('keeps the failure the error notice reported while a provider outage repeats', async () => {
			let outage = 0
			const harness = new TestHarness({
				presets: [retryPreset(200)],
				systemPlugins: [agentStatusPlugin],
				mockHandler: () => {
					outage++
					throw { type: 'server_error', message: `upstream 502 #${outage}`, retryAfterMs: 1, providerError: { statusCode: 502, body: 'bad gateway' } }
				},
			})
			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			await session.sendMessage('Hello')
			await waitForAgentStatus(session, entryAgentId, 'errored')
			// While a retry runs the agent is not stopped; read it in a backoff after its second failure (400 ms or more).
			const failedTwice = () => {
				const agent = session.state.agents.get(entryAgentId)
				return agent?.status === 'errored' && (agent.consecutiveInferenceFailures ?? 0) >= 2
			}
			const deadline = Date.now() + 5_000
			while (!failedTwice() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
			expect(failedTwice()).toBe(true)

			const live = agentStoppedNotifications(session)
			expect(live).toHaveLength(1)
			const [firstFailure] = await session.getEventsByType(llmEvents, 'inference_failed')
			expect(await stoppedAgents(session)).toEqual([{ ...withoutSession(live[0]), timestamp: firstFailure.timestamp }])

			await harness.shutdown()
		})

		it('lists a paused agent after a server restart, and not once it is resumed', async () => {
			const presets = [createTestPreset()]
			const llmProvider = MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] })
			const first = new TestHarness({ presets, systemPlugins: [agentStatusPlugin], llmProvider })
			const session = await first.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			await session.sendAndWaitForIdle('Hello')
			const live = await first.sessionManager.getSession(session.sessionId)
			if (!live.ok) throw new Error(live.error.message)
			const paused = await live.value.pauseAgent(entryAgentId, 'Pausing for review')
			if (!paused.ok) throw new Error(paused.error.message)
			const notified = agentStoppedNotifications(session)
			expect(notified).toHaveLength(1)
			await first.shutdown()

			const restarted = new TestHarness({ presets, systemPlugins: [agentStatusPlugin], llmProvider, eventStore: first.eventStore })
			await restarted.sessionManager.loadAllSessions()
			const reloaded = await restarted.sessionManager.getSession(session.sessionId)
			if (!reloaded.ok) throw new Error(reloaded.error.message)
			expect(await stoppedAgents(reloaded.value)).toEqual([{ ...withoutSession(notified[0]), timestamp: expect.any(Number) }])
			expect((await stoppedAgents(reloaded.value))[0]).toMatchObject({ kind: 'paused', reason: 'manual', message: 'Pausing for review' })

			const resumed = await reloaded.value.resumeAgent(entryAgentId)
			if (!resumed.ok) throw new Error(resumed.error.message)
			expect(await stoppedAgents(reloaded.value)).toEqual([])

			await restarted.shutdown()
		})
	})
})
