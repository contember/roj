import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createMultiAgentPreset, createTestPreset, TestHarness } from '~/testing/index.js'
import type { AgentCounters } from './plugin.js'
import { limitsGuardPlugin } from './plugin.js'

function createLimitsHarness(options: Omit<ConstructorParameters<typeof TestHarness>[0], 'systemPlugins'>) {
	return new TestHarness({ ...options, systemPlugins: [limitsGuardPlugin] })
}

import type { TestSession } from '~/testing/index.js'

/**
 * Wait for a specific agent to reach 'paused' status (or timeout).
 * Polls the TestSession's state directly (live getter).
 */
async function waitForAgentPaused(session: TestSession, agentId: AgentId, timeoutMs = 10000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const agentState = session.state.agents.get(agentId)
		if (agentState?.status === 'paused') return
		await new Promise(r => setTimeout(r, 10))
	}
	throw new Error(`waitForAgentPaused timed out after ${timeoutMs}ms for agent ${agentId}`)
}

/**
 * Wait for all agents to be either idle (pending with no work) or paused.
 */
async function waitForAllSettled(session: TestSession, timeoutMs = 10000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	outer: while (Date.now() < deadline) {
		for (const [, agentState] of session.state.agents) {
			if (agentState.status === 'paused') continue
			if (agentState.status === 'pending' && agentState.pendingToolCalls.length === 0 && agentState.pendingToolResults.length === 0) {
				continue
			}
			await new Promise(r => setTimeout(r, 10))
			continue outer
		}
		// Double-check after a brief delay
		await new Promise(r => setTimeout(r, 10))
		for (const [, agentState] of session.state.agents) {
			if (agentState.status === 'paused') continue
			if (agentState.status === 'pending' && agentState.pendingToolCalls.length === 0 && agentState.pendingToolResults.length === 0) {
				continue
			}
			continue outer
		}
		return
	}
	throw new Error(`waitForAllSettled timed out after ${timeoutMs}ms`)
}

describe('limits-guard plugin', () => {
	// =========================================================================
	// hard limits
	// =========================================================================

	describe('hard limits', () => {
		it('agent exceeding inference hard limit → agent_paused event → agent stops', async () => {
			let inferenceCount = 0

			const harness = createLimitsHarness({
				presets: [createTestPreset({
					orchestratorSystem: 'Test agent.',
					orchestratorPlugins: [limitsGuardPlugin.configureAgent({ limits: { maxTurns: 3 } })],
				})],
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
			await waitForAgentPaused(session, entryAgentId)

			const entryAgent = session.state.agents.get(entryAgentId)!
			expect(entryAgent.status).toBe('paused')

			const pausedEvents = await session.getEventsByType(agentEvents, 'agent_paused')
			expect(pausedEvents.length).toBeGreaterThanOrEqual(1)
			const pauseEvent = pausedEvents.find(e => e.agentId === entryAgentId)
			expect(pauseEvent).toBeDefined()
			expect(pauseEvent!.reason).toBe('handler')

			await harness.shutdown()
		})

		it('agent exceeding tool call hard limit → agent paused', async () => {
			let callNum = 0

			const harness = createLimitsHarness({
				presets: [createTestPreset({
					orchestratorSystem: 'Test agent.',
					orchestratorPlugins: [limitsGuardPlugin.configureAgent({ limits: { maxToolCalls: 3, maxTurns: 100 } })],
				})],
				mockHandler: () => {
					callNum++
					return {
						content: null,
						toolCalls: [
							{ id: ToolCallId(`tc${callNum}a`), name: 'tell_user', input: { message: `A${callNum}` } },
							{ id: ToolCallId(`tc${callNum}b`), name: 'tell_user', input: { message: `B${callNum}` } },
						],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				},
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			await session.sendMessage('Start')
			await waitForAgentPaused(session, entryAgentId)

			const entryAgent = session.state.agents.get(entryAgentId)!
			expect(entryAgent.status).toBe('paused')

			const counters = selectPluginState<Map<AgentId, AgentCounters>>(session.state, 'agentLimits')?.get(entryAgentId)
			expect(counters).toBeDefined()
			expect(counters!.toolCallCount).toBeGreaterThanOrEqual(3)

			await harness.shutdown()
		})

		it('agent exceeding spawned agent limit → agent paused', async () => {
			let orchestratorCalls = 0

			const harness = createLimitsHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						return {
							content: null,
							toolCalls: [
								{ id: ToolCallId(`tc${orchestratorCalls}a`), name: 'start_worker', input: { message: `Task ${orchestratorCalls}a` } },
								{ id: ToolCallId(`tc${orchestratorCalls}b`), name: 'start_worker', input: { message: `Task ${orchestratorCalls}b` } },
							],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			const orchestratorId = session.getEntryAgentId()!
			await session.sendMessage('Start')
			await waitForAgentPaused(session, orchestratorId, 15000)

			const orch = session.state.agents.get(orchestratorId)!
			expect(orch.status).toBe('paused')

			const counters = selectPluginState<Map<AgentId, AgentCounters>>(session.state, 'agentLimits')?.get(orchestratorId)
			expect(counters).toBeDefined()
			expect(counters!.spawnedAgentCount).toBeGreaterThanOrEqual(10)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// soft limits (status display)
	// =========================================================================

	describe('soft limits (status display)', () => {
		it('approaching limit (80%) → status contains warning message', async () => {
			let inferenceCount = 0
			let sawWarning = false

			const harness = createLimitsHarness({
				presets: [createTestPreset({
					orchestratorSystem: 'Test agent.',
					orchestratorPlugins: [limitsGuardPlugin.configureAgent({ limits: { maxTurns: 5 } })],
				})],
				mockHandler: (request) => {
					inferenceCount++
					const messagesStr = JSON.stringify(request.messages)
					if (messagesStr.includes('Approaching maxTurns limit')) {
						sawWarning = true
					}
					if (inferenceCount < 5) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId(`tc${inferenceCount}`), name: 'tell_user', input: { message: `Turn ${inferenceCount}` } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			await session.sendMessage('Start')
			// Agent will be paused at turn 5 or finish at turn 5 if last response has no tools
			await waitForAllSettled(session)

			expect(sawWarning).toBe(true)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// counter tracking
	// =========================================================================

	describe('counter tracking', () => {
		it('each inference increments inferenceCount', async () => {
			let callCount = 0

			const harness = createLimitsHarness({
				presets: [createTestPreset({
					orchestratorSystem: 'Test agent.',
					orchestratorPlugins: [limitsGuardPlugin.configureAgent({ limits: { maxTurns: 100 } })],
				})],
				mockHandler: () => {
					callCount++
					if (callCount <= 2) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId(`tc${callCount}`), name: 'tell_user', input: { message: `Msg ${callCount}` } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			const counters = selectPluginState<Map<AgentId, AgentCounters>>(session.state, 'agentLimits')?.get(session.getEntryAgentId()!)
			expect(counters).toBeDefined()
			expect(counters!.inferenceCount).toBe(3) // 2 with tools + 1 final

			await harness.shutdown()
		})

		it('each tool call increments toolCallCount', async () => {
			let callCount = 0

			const harness = createLimitsHarness({
				presets: [createTestPreset({
					orchestratorSystem: 'Test agent.',
					orchestratorPlugins: [limitsGuardPlugin.configureAgent({ limits: { maxTurns: 100 } })],
				})],
				mockHandler: () => {
					callCount++
					if (callCount === 1) {
						return {
							content: null,
							toolCalls: [
								{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'A' } },
								{ id: ToolCallId('tc2'), name: 'tell_user', input: { message: 'B' } },
							],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			const counters = selectPluginState<Map<AgentId, AgentCounters>>(session.state, 'agentLimits')?.get(session.getEntryAgentId()!)
			expect(counters).toBeDefined()
			expect(counters!.toolCallCount).toBe(2)

			await harness.shutdown()
		})

		it('each agent spawn increments parent spawnedAgentCount', async () => {
			let orchestratorCalls = 0

			const harness = createLimitsHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [
									{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Task 1' } },
									{ id: ToolCallId('tc2'), name: 'start_worker', input: { message: 'Task 2' } },
								],
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
			await session.sendAndWaitForIdle('Start', { timeoutMs: 10000 })

			const orchestratorId = session.getEntryAgentId()!
			const counters = selectPluginState<Map<AgentId, AgentCounters>>(session.state, 'agentLimits')?.get(orchestratorId)
			expect(counters).toBeDefined()
			expect(counters!.spawnedAgentCount).toBe(2)

			await harness.shutdown()
		})

		it('each mailbox message increments sender messagesSentCount', async () => {
			let orchestratorCalls = 0
			let workerCalls = 0

			const harness = createLimitsHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Task' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}
					workerCalls++
					if (workerCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc2'), name: 'send_message', input: { to: 'parent', message: 'Report' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start', { timeoutMs: 10000 })

			const workerCounters = selectPluginState<Map<AgentId, AgentCounters>>(session.state, 'agentLimits')?.get(AgentId('worker_1'))
			expect(workerCounters).toBeDefined()
			expect(workerCounters!.messagesSentCount).toBeGreaterThanOrEqual(1)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// resume resets
	// =========================================================================

	describe('resume resets', () => {
		it('agent_resumed → pattern-based counters reset, cumulative counters preserved', async () => {
			const harness = createLimitsHarness({
				presets: [createTestPreset({
					orchestratorSystem: 'Test agent.',
					orchestratorPlugins: [limitsGuardPlugin.configureAgent({
						limits: { maxRepeatedResponses: 2, maxTurns: 100 },
					})],
				})],
				// Always return the same text → triggers maxRepeatedResponses
				mockHandler: () => ({
					content: 'I am stuck',
					toolCalls: [],
					finishReason: 'stop',
					metrics: MockLLMProvider.defaultMetrics(),
				}),
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!

			// 1st identical response → ok → idle
			await session.sendAndWaitForIdle('Message 1')
			// 2nd identical response → maxRepeatedResponses = 2 → paused
			await session.sendMessage('Message 2')
			await waitForAgentPaused(session, entryAgentId)

			expect(session.state.agents.get(entryAgentId)!.status).toBe('paused')

			// Resume the agent
			const resumeResult = await session.callPluginMethod('agents.resume', {
				agentId: String(entryAgentId),
			})
			expect(resumeResult.ok).toBe(true)

			// All counters should be reset after resume
			const countersAfterResume = selectPluginState<Map<AgentId, AgentCounters>>(session.state, 'agentLimits')?.get(entryAgentId)
			expect(countersAfterResume).toBeDefined()
			expect(countersAfterResume!.inferenceCount).toBe(0)
			expect(countersAfterResume!.toolCallCount).toBe(0)
			expect(countersAfterResume!.recentResponseHashes).toEqual([])

			// Agent resumes with reset counters. Wait for it to settle (no work → idle).
			await session.waitForIdle()

			// Send 2 more messages to hit the limit again
			await session.sendAndWaitForIdle('Message 3')
			await session.sendMessage('Message 4')
			await waitForAgentPaused(session, entryAgentId)

			const resumedEvents = await session.getEventsByType(agentEvents, 'agent_resumed')
			expect(resumedEvents.filter(e => e.agentId === entryAgentId)).toHaveLength(1)

			await harness.shutdown()
		})
	})
})
