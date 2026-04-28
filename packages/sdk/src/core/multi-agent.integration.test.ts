import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createMultiAgentPreset, TestHarness } from '~/testing/index.js'

describe('core: multi-agent flows', () => {
	it('orchestrator spawns worker → worker processes → sends result to orchestrator → orchestrator continues', async () => {
		let orchestratorCalls = 0
		let orchestratorSawResult = false

		let workerCalls = 0

		const harness = new TestHarness({
			presets: [createMultiAgentPreset([
				{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
			], { orchestratorSystem: 'Orchestrator agent.' })],
			mockHandler: (request) => {
				if (request.systemPrompt.includes('Orchestrator')) {
					orchestratorCalls++
					if (orchestratorCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Do work' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					// Check if orchestrator received the worker's report
					const userMessages = request.messages.filter(m => m.role === 'user')
					if (userMessages.some(m => typeof m.content === 'string' && m.content.includes('Work result: done'))) {
						orchestratorSawResult = true
					}
					return { content: 'All done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				// Worker: send result to parent on first call, finish on second
				workerCalls++
				if (workerCalls === 1) {
					return {
						content: null,
						toolCalls: [{ id: ToolCallId('tc2'), name: 'send_message', input: { to: 'parent', message: 'Work result: done' } }],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				}
				return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Start', { timeoutMs: 10000 })

		expect(orchestratorSawResult).toBe(true)

		// Both agents should be idle
		const orchState = session.state.agents.get(session.getEntryAgentId()!)!
		expect(orchState.status).toBe('pending')
		const workerState = session.state.agents.get(AgentId('worker_1'))!
		expect(workerState.status).toBe('pending')

		await harness.shutdown()
	})

	it('orchestrator spawns multiple workers → all process concurrently', async () => {
		let orchestratorCalls = 0
		const workerCallCounts = new Map<string, number>()

		const harness = new TestHarness({
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
								{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Task A' } },
								{ id: ToolCallId('tc2'), name: 'start_worker', input: { message: 'Task B' } },
								{ id: ToolCallId('tc3'), name: 'start_worker', input: { message: 'Task C' } },
							],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				// Workers
				const agentId = request.systemPrompt.includes('Worker') ? 'worker' : 'unknown'
				workerCallCounts.set(agentId, (workerCallCounts.get(agentId) ?? 0) + 1)
				return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Start', { timeoutMs: 10000 })

		// All three workers should exist
		expect(session.state.agents.has(AgentId('worker_1'))).toBe(true)
		expect(session.state.agents.has(AgentId('worker_2'))).toBe(true)
		expect(session.state.agents.has(AgentId('worker_3'))).toBe(true)

		// All workers should have been called
		expect(workerCallCounts.get('worker')).toBeGreaterThanOrEqual(3)

		// All workers should be idle
		for (const id of [AgentId('worker_1'), AgentId('worker_2'), AgentId('worker_3')]) {
			expect(session.state.agents.get(id)!.status).toBe('pending')
		}

		await harness.shutdown()
	})

	it('parent pauses child → child stops, parent notified', async () => {
		let orchestratorCalls = 0

		const harness = new TestHarness({
			presets: [createMultiAgentPreset([
				{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
			], { orchestratorSystem: 'Orchestrator agent.' })],
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

		// Pause the child
		const pauseResult = await session.callPluginMethod('agents.pause', { agentId: 'worker_1' })
		expect(pauseResult.ok).toBe(true)

		// Child should be paused
		expect(session.state.agents.get(AgentId('worker_1'))!.status).toBe('paused')

		// agent_paused event emitted
		const pausedEvents = await session.getEventsByType(agentEvents, 'agent_paused')
		expect(pausedEvents.some(e => e.agentId === AgentId('worker_1'))).toBe(true)

		await harness.shutdown()
	})

	it('parent resumes child → child continues', async () => {
		let orchestratorCalls = 0
		let workerCalls = 0

		const harness = new TestHarness({
			presets: [createMultiAgentPreset([
				{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
			], { orchestratorSystem: 'Orchestrator agent.' })],
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
				workerCalls++
				return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Start')

		// Pause
		const pauseResult = await session.callPluginMethod('agents.pause', { agentId: 'worker_1' })
		expect(pauseResult.ok).toBe(true)
		expect(session.state.agents.get(AgentId('worker_1'))!.status).toBe('paused')

		// Resume
		const resumeResult = await session.callPluginMethod('agents.resume', { agentId: 'worker_1' })
		expect(resumeResult.ok).toBe(true)

		await session.waitForIdle()

		// Worker should have processed again after resume
		expect(session.state.agents.get(AgentId('worker_1'))!.status).toBe('pending')

		// agent_resumed event should exist
		const resumedEvents = await session.getEventsByType(agentEvents, 'agent_resumed')
		expect(resumedEvents.some(e => e.agentId === AgentId('worker_1'))).toBe(true)

		await harness.shutdown()
	})

	it('child agent completes → parent receives completion message (if configured)', async () => {
		let orchestratorCalls = 0
		let orchestratorSawCompletion = false

		const harness = new TestHarness({
			presets: [createMultiAgentPreset([
				{
					name: 'worker',
					system: 'Worker agent.',
					tools: [],
					agents: [],
					plugins: [{ pluginName: 'mailbox', config: { sendCompletionMessage: true } }],
				},
			], { orchestratorSystem: 'Orchestrator agent.' })],
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
					// Check if completion message arrived
					const userMessages = request.messages.filter(m => m.role === 'user')
					if (userMessages.some(m => typeof m.content === 'string' && m.content.includes('Task completed.'))) {
						orchestratorSawCompletion = true
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				// Worker completes immediately
				return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Start', { timeoutMs: 10000 })

		expect(orchestratorSawCompletion).toBe(true)

		await harness.shutdown()
	})

	it('deeply nested agents: orch → A → B → B reports to A → A reports to orch', async () => {
		let orchestratorCalls = 0
		let workerACalls = 0
		let workerBCalls = 0
		let orchestratorSawFinalReport = false

		const harness = new TestHarness({
			presets: [createMultiAgentPreset([
				{ name: 'worker_a', system: 'Worker A agent.', tools: [], agents: ['worker_b'] },
				{ name: 'worker_b', system: 'Worker B agent.', tools: [], agents: [] },
			], { orchestratorSystem: 'Orchestrator agent.' })],
			mockHandler: (request) => {
				if (request.systemPrompt.includes('Orchestrator')) {
					orchestratorCalls++
					if (orchestratorCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker_a', input: { message: 'Coordinate' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					// Check for final report from A
					const userMessages = request.messages.filter(m => m.role === 'user')
					if (userMessages.some(m => typeof m.content === 'string' && m.content.includes('Final report from A'))) {
						orchestratorSawFinalReport = true
					}
					return { content: 'All done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}

				if (request.systemPrompt.includes('Worker A')) {
					workerACalls++
					if (workerACalls === 1) {
						// A spawns B
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc2'), name: 'start_worker_b', input: { message: 'Sub-task for B' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					// A received report from B, now report to orchestrator
					const userMessages = request.messages.filter(m => m.role === 'user')
					if (userMessages.some(m => typeof m.content === 'string' && m.content.includes('B result: success'))) {
						// Check if we already sent the report (tool result in messages means we did)
						const toolMessages = request.messages.filter(m => m.role === 'tool')
						if (toolMessages.length > 0 && workerACalls > 3) {
							return { content: 'A done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
						}
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc4'), name: 'send_message', input: { to: 'parent', message: 'Final report from A' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'A waiting', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}

				// Worker B
				workerBCalls++
				if (workerBCalls === 1) {
					// B reports to A
					return {
						content: null,
						toolCalls: [{ id: ToolCallId('tc3'), name: 'send_message', input: { to: 'parent', message: 'B result: success' } }],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				}
				return { content: 'B done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Start', { timeoutMs: 10000 })

		// Verify hierarchy
		expect(session.state.agents.has(AgentId('worker_a_1'))).toBe(true)
		expect(session.state.agents.has(AgentId('worker_b_1'))).toBe(true)
		expect(session.state.agents.get(AgentId('worker_a_1'))!.parentId).toBe(session.getEntryAgentId()!)
		expect(session.state.agents.get(AgentId('worker_b_1'))!.parentId).toBe(AgentId('worker_a_1'))

		// Orchestrator received final report from A
		expect(orchestratorSawFinalReport).toBe(true)

		await harness.shutdown()
	})
})
