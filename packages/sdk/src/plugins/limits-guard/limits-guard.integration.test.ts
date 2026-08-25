import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { AgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { InferenceRequest } from '~/core/llm/provider.js'
import { ModelId } from '~/core/llm/schema.js'
import { llmEvents } from '~/core/llm/state.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { createTool } from '~/core/tools/definition.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { toolEvents } from '~/core/tools/state.js'
import { Ok } from '~/lib/utils/result.js'
import { contextCompactPlugin } from '~/plugins/context-compact/index.js'
import { getAgentMailbox, selectMailboxState } from '~/plugins/mailbox/query.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import { createMultiAgentPreset, createTestPreset, TestHarness } from '~/testing/index.js'
import type { AgentCounters } from './plugin.js'
import { limitsEvents, limitsGuardPlugin } from './plugin.js'

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

async function waitUntil(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
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

		it('communication-only loop without new inbound work → soft-stops and remains wakeable', async () => {
			let inferenceCount = 0

			const harness = createLimitsHarness({
				presets: [createTestPreset({
					orchestratorSystem: 'Test agent.',
					orchestratorPlugins: [limitsGuardPlugin.configureAgent({
						limits: { maxConsecutiveNoProgressTurns: 3, maxTurns: 100 },
					})],
				})],
				mockHandler: () => {
					inferenceCount++
					if (inferenceCount > 4) {
						return {
							content: 'Recovered for new work',
							toolCalls: [],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return {
						content: null,
						toolCalls: [{
							id: ToolCallId(`tc${inferenceCount}`),
							name: 'tell_user',
							input: { message: `Still waiting, update ${inferenceCount}` },
						}],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				},
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			await session.sendAndWaitForIdle('Start')

			// The response to "Start" had inbound work. The next three turns were
			// driven only by the previous tell_user result, so the fourth inference
			// reaches the limit and its redundant tool call is suppressed.
			expect(inferenceCount).toBe(4)
			const toolStarted = await session.getEventsByType(toolEvents, 'tool_started')
			expect(toolStarted).toHaveLength(3)

			const pauseEvents = await session.getEventsByType(agentEvents, 'agent_paused')
			expect(pauseEvents.some((event) => event.agentId === entryAgentId)).toBe(false)

			const warningEvents = await session.getEventsByType(limitsEvents, 'limit_warning')
			const noProgressEvent = warningEvents.find((event) =>
				event.agentId === entryAgentId
				&& event.limitName === 'maxConsecutiveNoProgressTurns'
			)
			expect(noProgressEvent?.currentValue).toBe(3)
			expect(noProgressEvent?.message).toContain('until new input arrives')
			expect(session.state.agents.get(entryAgentId)?.status).toBe('pending')

			// The stop is recoverable without agents.resume or human intervention.
			await session.sendAndWaitForIdle('Now do real work')
			expect(inferenceCount).toBe(5)
			expect(session.state.agents.get(entryAgentId)?.status).toBe('pending')

			await harness.shutdown()
		})

		it('communication-only replies to distinct user messages do not count as no progress', async () => {
			let inferenceCount = 0
			let allowProcessing = false
			const preset = createTestPreset({
				orchestratorSystem: 'Test agent.',
				orchestratorPlugins: [limitsGuardPlugin.configureAgent({
					limits: { maxConsecutiveNoProgressTurns: 3, maxTurns: 100 },
				})],
			})
			preset.orchestrator.debounceCallback = () => {
				if (!allowProcessing) return 'wait'
				allowProcessing = false
				return 'process_now'
			}
			preset.orchestrator.checkIntervalMs = 1

			const harness = createLimitsHarness({
				presets: [preset],
				mockHandler: () => {
					inferenceCount++
					return {
						content: null,
						toolCalls: [{
							id: ToolCallId(`reply-${inferenceCount}`),
							name: 'tell_user',
							input: { message: `Reply ${inferenceCount}` },
						}],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				},
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!

			for (let messageNumber = 1; messageNumber <= 3; messageNumber++) {
				await session.sendMessage(`User message ${messageNumber}`)
				allowProcessing = true
				await waitUntil(() => {
					const state = session.state.agents.get(entryAgentId)
					return inferenceCount === messageNumber && state?.pendingToolResults.length === 1
				})

				const counters = selectPluginState<Map<AgentId, AgentCounters>>(
					session.state,
					'agentLimits',
				)?.get(entryAgentId)
				expect(counters?.consecutiveNoProgressTurns).toBe(0)
			}

			const consumedEvents = await session.getEventsByType(agentEvents, 'agent_input_consumed')
			expect(consumedEvents).toHaveLength(3)
			expect(consumedEvents.every((event) => event.sourcePlugins.includes('user-chat'))).toBe(true)

			const pauseEvents = await session.getEventsByType(agentEvents, 'agent_paused')
			expect(pauseEvents.some((event) => event.agentId === entryAgentId)).toBe(false)
			const warningEvents = await session.getEventsByType(limitsEvents, 'limit_warning')
			expect(warningEvents.some((event) => event.limitName === 'maxConsecutiveNoProgressTurns')).toBe(false)

			await harness.shutdown()
		})

		it('send_message followed by non-communication work does not trip the no-progress limit', async () => {
			let workerInferenceCount = 0
			let workCount = 0

			const recordWork = createTool({
				name: 'record_work',
				description: 'Record one unit of real work.',
				input: z.object({}),
				execute: async () => {
					workCount++
					return Ok('work recorded')
				},
			})

			const harness = createLimitsHarness({
				presets: [createMultiAgentPreset([
					{
						name: 'worker',
						system: 'Worker agent.',
						tools: [recordWork],
						agents: [],
						plugins: [limitsGuardPlugin.configureAgent({
							limits: { maxConsecutiveNoProgressTurns: 2, maxTurns: 100 },
						})],
					},
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.endsWith('Orchestrator agent.')) {
						const hasStartedWorker = request.messages.some((message) =>
							message.role === 'assistant'
							&& message.toolCalls?.some((toolCall) => toolCall.name === 'start_worker')
						)
						if (!hasStartedWorker) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('start-worker'), name: 'start_worker', input: { message: 'Do the work' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return {
							content: 'Orchestration complete',
							toolCalls: [],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}

					workerInferenceCount++
					switch (workerInferenceCount) {
						case 1:
							return {
								content: null,
								toolCalls: [{
									id: ToolCallId('worker-progress'),
									name: 'send_message',
									input: { to: 'parent', message: 'Starting real work' },
								}],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						case 2:
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('worker-work'), name: 'record_work', input: {} }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						case 3:
							return {
								content: null,
								toolCalls: [{
									id: ToolCallId('worker-result'),
									name: 'send_message',
									input: { to: 'parent', message: 'Real work complete' },
								}],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						default:
							return {
								content: 'WAITING',
								toolCalls: [],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
					}
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start', { timeoutMs: 10_000 })

			expect(workCount).toBe(1)
			expect(workerInferenceCount).toBe(4)
			expect(session.state.agents.get(AgentId('worker_1'))?.status).toBe('pending')

			const pauseEvents = await session.getEventsByType(agentEvents, 'agent_paused')
			expect(pauseEvents.some((event) => event.agentId === AgentId('worker_1'))).toBe(false)

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
					orchestratorPlugins: [limitsGuardPlugin.configureAgent({
						limits: { maxTurns: 5, maxConsecutiveNoProgressTurns: 100 },
					})],
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

	// =========================================================================
	// budgets (cost / tokens)
	// =========================================================================

	describe('budgets', () => {
		it('agent exceeding cost budget → paused with budget_exceeded event', async () => {
			let n = 0
			const harness = createLimitsHarness({
				presets: [createTestPreset({
					orchestratorSystem: 'Test agent.',
					// $0.50 per call, $1.00 budget → pauses before the 3rd call.
					orchestratorPlugins: [limitsGuardPlugin.configureAgent({ limits: { maxCost: 1.0, maxTurns: 100 } })],
				})],
				mockHandler: () => {
					n++
					return {
						content: null,
						toolCalls: [{ id: ToolCallId(`tc${n}`), name: 'tell_user', input: { message: `Turn ${n}` } }],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetricsWithCost(0.5),
					}
				},
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			await session.sendMessage('Start')
			await waitForAgentPaused(session, entryAgentId)

			expect(session.state.agents.get(entryAgentId)!.status).toBe('paused')

			const counters = selectPluginState<Map<AgentId, AgentCounters>>(session.state, 'agentLimits')?.get(entryAgentId)
			expect(counters!.costSpent).toBeGreaterThanOrEqual(1.0)

			const budgetEvents = await session.getEventsByType(limitsEvents, 'budget_exceeded')
			const evt = budgetEvents.find(e => e.agentId === entryAgentId)
			expect(evt).toBeDefined()
			expect(evt!.scope).toBe('agent')
			expect(evt!.limitName).toBe('maxCost')

			await harness.shutdown()
		})

		it('costSpent is preserved across resume — budget cannot be bypassed by pausing', async () => {
			let n = 0
			const harness = createLimitsHarness({
				presets: [createTestPreset({
					orchestratorSystem: 'Test agent.',
					orchestratorPlugins: [limitsGuardPlugin.configureAgent({ limits: { maxCost: 1.0, maxTurns: 100 } })],
				})],
				mockHandler: () => {
					n++
					return {
						content: null,
						toolCalls: [{ id: ToolCallId(`tc${n}`), name: 'tell_user', input: { message: `Turn ${n}` } }],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetricsWithCost(0.5),
					}
				},
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			await session.sendMessage('Start')
			await waitForAgentPaused(session, entryAgentId)

			const before = selectPluginState<Map<AgentId, AgentCounters>>(session.state, 'agentLimits')?.get(entryAgentId)
			expect(before).toBeDefined()
			expect(before!.costSpent).toBeGreaterThanOrEqual(1.0)

			await session.callPluginMethod('agents.resume', { agentId: String(entryAgentId) })
			// Budget is still exhausted → agent pauses again immediately without inferring.
			await waitForAgentPaused(session, entryAgentId)

			const after = selectPluginState<Map<AgentId, AgentCounters>>(session.state, 'agentLimits')?.get(entryAgentId)
			expect(after).toBeDefined()
			// Anti-looping counter reset…
			expect(after!.inferenceCount).toBe(0)
			// …but spend preserved, so the cap is not bypassable.
			expect(after!.costSpent).toBeGreaterThanOrEqual(before!.costSpent)

			await harness.shutdown()
		})

		it('child pausing on budget → parent is notified via a child-paused message', async () => {
			let orchestratorCalls = 0
			let workerCalls = 0
			const harness = createLimitsHarness({
				presets: [createTestPreset({
					orchestratorSystem: 'Orchestrator agent.',
					agents: [{
						name: 'worker',
						system: 'Worker agent.',
						tools: [],
						agents: [],
						// $0.50 per call, $0.50 budget → pauses at the 2nd inference's
						// beforeInference (after one completed call spent the budget).
						plugins: [limitsGuardPlugin.configureAgent({ limits: { maxCost: 0.5, maxTurns: 100 } })],
					}],
				})],
				mockHandler: (request) => {
					// Worker: keep spending until the budget pauses it.
					if (request.systemPrompt.includes('Worker agent.')) {
						workerCalls++
						return {
							content: null,
							toolCalls: [{ id: ToolCallId(`w${workerCalls}`), name: 'tell_user', input: { message: `Work ${workerCalls}` } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetricsWithCost(0.5),
						}
					}
					// Orchestrator: spawn the worker exactly once, then idle.
					orchestratorCalls++
					if (orchestratorCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('spawn'), name: 'start_worker', input: { message: 'Do work' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Waiting', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendMessage('Start')
			await waitForAgentPaused(session, AgentId('worker_1'))

			const orchestratorId = session.getEntryAgentId()!
			// The mailbox plugin's onPause hook reports the pause to the parent.
			// onPause runs *after* the agent_paused event (which flips status to
			// 'paused'), so poll for the notification.
			const findNotice = async () =>
				(await session.getEventsByType(mailboxEvents, 'mailbox_message')).find(m =>
					m.toAgentId === orchestratorId
					&& m.message.from === AgentId('worker_1')
					&& m.message.content.includes('<child-paused')
					&& m.message.content.includes('worker_1'),
				)
			let notice = await findNotice()
			const deadline = Date.now() + 5000
			while (!notice && Date.now() < deadline) {
				await new Promise(r => setTimeout(r, 20))
				notice = await findNotice()
			}
			expect(notice).toBeDefined()

			await harness.shutdown()
		})

		it('child-paused notice is actually consumed by a parent that already went idle', async () => {
			// Regression guard for the lifecycle: a parent that finished its work is
			// NOT in a terminal "complete" state — it's persisted as `pending` with an
			// empty mailbox. When the child pauses and delivers <child-paused>, the
			// dequeue check flips the parent's decide() from "complete" back to "infer",
			// so the parent wakes and reads the message rather than leaving it unconsumed.
			let workerCalls = 0
			let orchestratorSawChildPaused = false

			const requestHasChildPaused = (request: InferenceRequest): boolean =>
				request.messages.some((m) => {
					const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
					return c.includes('<child-paused')
				})

			const harness = createLimitsHarness({
				presets: [createTestPreset({
					orchestratorSystem: 'Orchestrator agent.',
					agents: [{
						name: 'worker',
						system: 'Worker agent.',
						tools: [],
						agents: [],
						plugins: [limitsGuardPlugin.configureAgent({ limits: { maxCost: 0.5, maxTurns: 100 } })],
					}],
				})],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Worker agent.')) {
						workerCalls++
						return {
							content: null,
							toolCalls: [{ id: ToolCallId(`w${workerCalls}`), name: 'tell_user', input: { message: `Work ${workerCalls}` } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetricsWithCost(0.5),
						}
					}
					// Orchestrator: spawn the worker once, then go idle. Any later wake-up
					// is driven by an incoming message — record if it carried the notice.
					if (requestHasChildPaused(request)) orchestratorSawChildPaused = true
					if (workerCalls === 0) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('spawn'), name: 'start_worker', input: { message: 'Do work' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Acknowledged', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendMessage('Start')
			await waitForAgentPaused(session, AgentId('worker_1'))

			// The parent should wake from idle and run an inference that includes the
			// <child-paused> message — proving the notice is consumed, not orphaned.
			const deadline = Date.now() + 5000
			while (!orchestratorSawChildPaused && Date.now() < deadline) {
				await new Promise(r => setTimeout(r, 20))
			}
			expect(orchestratorSawChildPaused).toBe(true)

			// And the consumed message payload is pruned from the parent's mailbox.
			const orchestratorId = session.getEntryAgentId()!
			const mailbox = getAgentMailbox(selectMailboxState(session.state), orchestratorId)
			const childPausedMsg = mailbox.find((m) => m.content.includes('<child-paused'))
			expect(childPausedMsg).toBeUndefined()

			await harness.shutdown()
		})

		it('compaction (auxiliary inference) cost counts toward the budget', async () => {
			// The compaction summarization is a real, billed LLM call routed through
			// runAuxiliaryInference → auxiliary_inference_completed. It must be charged
			// against the cost budget, otherwise an agent could spend unboundedly on
			// compaction without ever tripping its cap.
			const REGULAR_COST = 0.1
			const SUMMARY_COST = 5.0

			// Compaction request detection: inline compaction appends a trailing user
			// message containing the summarization marker.
			const isSummarizationRequest = (request: InferenceRequest): boolean => {
				const last = request.messages[request.messages.length - 1]
				if (!last || last.role !== 'user') return false
				const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
				return content.includes('[CONTEXT COMPACTION REQUEST]')
			}

			const harness = new TestHarness({
				systemPlugins: [contextCompactPlugin, limitsGuardPlugin],
				presets: [createTestPreset({
					orchestratorSystem: 'Test agent.',
					plugins: [
						contextCompactPlugin.configure({
							compaction: { model: ModelId('mock'), maxTokens: 10, keepRecentMessages: 2 },
						}),
					],
					// Budget large enough to survive the cheap regular turns but small
					// enough that one expensive summarization call blows past it.
					orchestratorPlugins: [
						limitsGuardPlugin.configureAgent({ limits: { maxCost: 2.0, maxTurns: 100 } }),
					],
				})],
				mockHandler: (request) => {
					if (isSummarizationRequest(request)) {
						return {
							content: 'Summary of conversation so far.',
							toolCalls: [],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetricsWithCost(SUMMARY_COST),
						}
					}
					return {
						content: 'Agent response with some content to increase token count.',
						toolCalls: [],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetricsWithCost(REGULAR_COST),
					}
				},
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!

			// Returns once the agent is either idle or paused — used because we don't
			// know up front whether the compaction cost trips the budget on the same
			// turn (depends on beforeInference hook ordering) or on the next one.
			const waitForIdleOrPaused = async (timeoutMs = 10000): Promise<'idle' | 'paused'> => {
				const deadline = Date.now() + timeoutMs
				while (Date.now() < deadline) {
					const st = session.state.agents.get(entryAgentId)
					if (st?.status === 'paused') return 'paused'
					if (st?.status === 'pending' && st.pendingToolCalls.length === 0 && st.pendingToolResults.length === 0) {
						return 'idle'
					}
					await new Promise(r => setTimeout(r, 10))
				}
				throw new Error('waitForIdleOrPaused timed out')
			}

			await session.sendAndWaitForIdle('First message')
			await session.sendAndWaitForIdle('Second message')
			// Third message triggers compaction (the expensive summarization call).
			// It may pause on this turn or settle idle and pause on the next one.
			await session.sendMessage('Third message to trigger compaction')
			if (await waitForIdleOrPaused() === 'idle') {
				await session.sendMessage('Fourth message')
			}
			await waitForAgentPaused(session, entryAgentId)

			// Compaction genuinely ran and was billed.
			const auxEvents = await session.getEventsByType(llmEvents, 'auxiliary_inference_completed')
			expect(auxEvents.some((e) => e.metrics.cost === SUMMARY_COST)).toBe(true)

			// The summarization cost is reflected in the agent's tracked spend…
			const counters = selectPluginState<Map<AgentId, AgentCounters>>(session.state, 'agentLimits')?.get(entryAgentId)
			expect(counters).toBeDefined()
			expect(counters!.costSpent).toBeGreaterThanOrEqual(SUMMARY_COST)

			// …and it tripped the cost budget (the regular turns alone, at 0.1 each,
			// could never reach the 2.0 cap on their own here).
			const budgetEvents = await session.getEventsByType(limitsEvents, 'budget_exceeded')
			const evt = budgetEvents.find((e) => e.agentId === entryAgentId)
			expect(evt).toBeDefined()
			expect(evt!.scope).toBe('agent')
			expect(evt!.limitName).toBe('maxCost')

			await harness.shutdown()
		})
	})
})
