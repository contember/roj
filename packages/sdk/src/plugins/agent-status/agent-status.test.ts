import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
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
				llmProvider: MockLLMProvider.withError({ type: 'invalid_request', message: 'Bad request' }),
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
			expect(stopped[0].definitionName).toBeDefined()

			await harness.shutdown()
		})
	})
})
