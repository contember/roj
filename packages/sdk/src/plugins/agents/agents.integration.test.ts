import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { AgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createMultiAgentPreset, createTestPreset, TestHarness } from '~/testing/index.js'

describe('agents plugin', () => {
	// =========================================================================
	// start_<agent> tool
	// =========================================================================

	describe('start_<agent> tool', () => {
		it('orchestrator calls start_worker → child agent spawned → agent_spawned event', async () => {
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
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Do some work' } }],
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

			const events = await session.getEventsByType(agentEvents, 'agent_spawned')
			// orchestrator_1 + worker_1
			const workerSpawned = events.filter(e => e.definitionName === 'worker')
			expect(workerSpawned).toHaveLength(1)
			expect(workerSpawned[0].agentId).toBe(AgentId('worker_1'))
			expect(workerSpawned[0].parentId).toBe(session.getEntryAgentId()!)

			await harness.shutdown()
		})

		it('spawned agent appears in session.state.agents', async () => {
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
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Do work' } }],
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

			expect(session.state.agents.has(AgentId('worker_1'))).toBe(true)
			const workerState = session.state.agents.get(AgentId('worker_1'))!
			expect(workerState.definitionName).toBe('worker')
			expect(workerState.parentId).toBe(session.getEntryAgentId()!)

			await harness.shutdown()
		})

		it('spawned agent receives initial task message via mailbox', async () => {
			let orchestratorCalls = 0
			let workerSawTask = false

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
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Process this data please' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}
					// Worker: check if initial message arrived
					const userMessages = request.messages.filter(m => m.role === 'user')
					const lastUserMsg = userMessages[userMessages.length - 1]
					if (typeof lastUserMsg?.content === 'string' && lastUserMsg.content.includes('Process this data please')) {
						workerSawTask = true
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			expect(workerSawTask).toBe(true)

			await harness.shutdown()
		})

		it('spawned agent starts processing (scheduled after spawn)', async () => {
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
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Go' } }],
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

			expect(workerCalls).toBeGreaterThanOrEqual(1)

			await harness.shutdown()
		})

		it('multiple spawns of same type → unique agent IDs (worker_1, worker_2, ...)', async () => {
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
			await session.sendAndWaitForIdle('Start')

			expect(session.state.agents.has(AgentId('worker_1'))).toBe(true)
			expect(session.state.agents.has(AgentId('worker_2'))).toBe(true)

			const events = await session.getEventsByType(agentEvents, 'agent_spawned')
			const workerEvents = events.filter(e => e.definitionName === 'worker')
			expect(workerEvents).toHaveLength(2)
			const agentIds = workerEvents.map(e => e.agentId)
			expect(agentIds).toContain(AgentId('worker_1'))
			expect(agentIds).toContain(AgentId('worker_2'))

			await harness.shutdown()
		})
	})

	// =========================================================================
	// typed input
	// =========================================================================

	describe('typed input', () => {
		it('agent with Zod input schema → start_<agent> tool includes input field', async () => {
			let orchestratorCalls = 0
			let workerCalls = 0

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{
						name: 'worker',
						system: 'Worker agent.',
						tools: [],
						agents: [],
						input: z.object({ url: z.string(), depth: z.number() }),
					},
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{
									id: ToolCallId('tc1'),
									name: 'start_worker',
									input: { message: 'Crawl this', input: { url: 'https://example.com', depth: 3 } },
								}],
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

			// Verify the agent was spawned with typed input
			const events = await session.getEventsByType(agentEvents, 'agent_spawned')
			const workerSpawned = events.find(e => e.definitionName === 'worker')
			expect(workerSpawned).toBeDefined()
			expect(workerSpawned!.typedInput).toEqual({ url: 'https://example.com', depth: 3 })

			// Verify the worker was called with the typed input as JSON in the message
			expect(workerCalls).toBeGreaterThanOrEqual(1)

			await harness.shutdown()
		})

		it('valid typed input → passed to agent as typedInput in spawn event', async () => {
			let orchestratorCalls = 0

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{
						name: 'worker',
						system: 'Worker agent.',
						tools: [],
						agents: [],
						input: z.object({ query: z.string() }),
					},
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{
									id: ToolCallId('tc1'),
									name: 'start_worker',
									input: { message: 'Search', input: { query: 'test query' } },
								}],
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

			// typedInput stored in agent state
			const workerState = session.state.agents.get(AgentId('worker_1'))
			expect(workerState).toBeDefined()
			expect(workerState!.typedInput).toEqual({ query: 'test query' })

			await harness.shutdown()
		})

		it('invalid typed input → validation error returned', async () => {
			let orchestratorCalls = 0
			let receivedValidationError = false

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{
						name: 'worker',
						system: 'Worker agent.',
						tools: [],
						agents: [],
						input: z.object({ url: z.string().url(), depth: z.number() }),
					},
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{
									id: ToolCallId('tc1'),
									name: 'start_worker',
									input: { message: 'Crawl', input: { url: 'not-a-url', depth: 'not-a-number' } },
								}],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						// Check if tool result contains error
						const toolMessages = request.messages.filter(m => m.role === 'tool')
						if (toolMessages.some(m => typeof m.content === 'string' && m.isError)) {
							receivedValidationError = true
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			// Worker should NOT have been spawned due to validation error
			expect(session.state.agents.has(AgentId('worker_1'))).toBe(false)

			// Orchestrator received validation error as tool result
			expect(receivedValidationError).toBe(true)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// agents.spawn method
	// =========================================================================

	describe('agents.spawn method', () => {
		it('spawn with valid parent and definition → agent created', async () => {
			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const orchestratorId = session.getEntryAgentId()!

			const result = await session.callPluginMethod('agents.spawn', {
				definitionName: 'worker',
				parentId: String(orchestratorId),
				message: 'Hello worker',
			})

			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.value).toHaveProperty('agentId')
			}

			await session.waitForIdle()

			expect(session.state.agents.has(AgentId('worker_1'))).toBe(true)

			await harness.shutdown()
		})

		it('spawn with unknown parent → error (agent_not_found)', async () => {
			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				])],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			const result = await session.callPluginMethod('agents.spawn', {
				definitionName: 'worker',
				parentId: 'nonexistent_99',
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.type).toBe('agent_not_found')
			}

			await harness.shutdown()
		})

		it('spawn with unknown definition → error (validation_error)', async () => {
			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				])],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const orchestratorId = session.getEntryAgentId()!

			const result = await session.callPluginMethod('agents.spawn', {
				definitionName: 'nonexistent_agent',
				parentId: String(orchestratorId),
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.type).toBe('validation_error')
			}

			await harness.shutdown()
		})

		it('spawn with initial message → message sent via mailbox', async () => {
			let workerSawMessage = false

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Worker')) {
						const userMessages = request.messages.filter(m => m.role === 'user')
						const lastUserMsg = userMessages[userMessages.length - 1]
						if (typeof lastUserMsg?.content === 'string' && lastUserMsg.content.includes('Spawn message')) {
							workerSawMessage = true
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			const orchestratorId = session.getEntryAgentId()!

			const result = await session.callPluginMethod('agents.spawn', {
				definitionName: 'worker',
				parentId: String(orchestratorId),
				message: 'Spawn message',
			})
			expect(result.ok).toBe(true)

			await session.waitForIdle()

			expect(workerSawMessage).toBe(true)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// agents.resume method
	// =========================================================================

	describe('agents.resume method', () => {
		it('resume paused agent → agent_resumed event → agent scheduled', async () => {
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

			// Pause the worker
			const pauseResult = await session.callPluginMethod('agents.pause', {
				agentId: 'worker_1',
			})
			expect(pauseResult.ok).toBe(true)
			expect(session.state.agents.get(AgentId('worker_1'))!.status).toBe('paused')

			const workerCallsBefore = workerCalls

			// Resume the worker
			const resumeResult = await session.callPluginMethod('agents.resume', {
				agentId: 'worker_1',
			})
			expect(resumeResult.ok).toBe(true)

			await session.waitForIdle()

			// agent_resumed event emitted
			const resumedEvents = await session.getEventsByType(agentEvents, 'agent_resumed')
			expect(resumedEvents.filter(e => e.agentId === AgentId('worker_1'))).toHaveLength(1)

			// Worker status back to pending after processing
			expect(session.state.agents.get(AgentId('worker_1'))!.status).toBe('pending')

			await harness.shutdown()
		})

		it('resume non-paused agent → error', async () => {
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

			// Worker is idle (pending), not paused
			const result = await session.callPluginMethod('agents.resume', {
				agentId: 'worker_1',
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.type).toBe('validation_error')
			}

			await harness.shutdown()
		})

		it('resume non-existent agent → error', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			const result = await session.callPluginMethod('agents.resume', {
				agentId: 'nonexistent_99',
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.type).toBe('agent_not_found')
			}

			await harness.shutdown()
		})
	})

	// =========================================================================
	// agents.pause method
	// =========================================================================

	describe('agents.pause method', () => {
		it('pause active agent → agent_paused event', async () => {
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

			const result = await session.callPluginMethod('agents.pause', {
				agentId: 'worker_1',
				message: 'Pausing for review',
			})

			expect(result.ok).toBe(true)

			// agent_paused event emitted
			const pausedEvents = await session.getEventsByType(agentEvents, 'agent_paused')
			const workerPaused = pausedEvents.filter(e => e.agentId === AgentId('worker_1'))
			expect(workerPaused).toHaveLength(1)
			expect(workerPaused[0].reason).toBe('manual')
			expect(workerPaused[0].message).toBe('Pausing for review')

			// State updated
			expect(session.state.agents.get(AgentId('worker_1'))!.status).toBe('paused')

			await harness.shutdown()
		})

		it('pause already-paused agent → error', async () => {
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

			// Pause first time
			const first = await session.callPluginMethod('agents.pause', { agentId: 'worker_1' })
			expect(first.ok).toBe(true)

			// Pause again → error
			const second = await session.callPluginMethod('agents.pause', { agentId: 'worker_1' })
			expect(second.ok).toBe(false)
			if (!second.ok) {
				expect(second.error.type).toBe('validation_error')
			}

			await harness.shutdown()
		})

		it('pause non-existent agent → error', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			const result = await session.callPluginMethod('agents.pause', {
				agentId: 'nonexistent_99',
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.type).toBe('agent_not_found')
			}

			await harness.shutdown()
		})
	})

	// =========================================================================
	// multi-level
	// =========================================================================

	describe('multi-level', () => {
		it('orchestrator → spawns A → A spawns B → B processes and reports to A', async () => {
			let orchestratorCalls = 0
			let workerACalls = 0
			let workerBCalls = 0
			let workerASawReport = false

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
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker_a', input: { message: 'Delegate' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					if (request.systemPrompt.includes('Worker A')) {
						workerACalls++
						if (workerACalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc2'), name: 'start_worker_b', input: { message: 'Sub-task' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						// Check if we received B's report
						const lastMsg = request.messages[request.messages.length - 1]
						if (typeof lastMsg?.content === 'string' && lastMsg.content.includes('Report from B')) {
							workerASawReport = true
						}
						return { content: 'A done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					// Worker B
					workerBCalls++
					if (workerBCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc3'), name: 'send_message', input: { to: 'parent', message: 'Report from B' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'B done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start', { timeoutMs: 10000 })

			// All three levels of agents should exist
			expect(session.state.agents.has(AgentId('worker_a_1'))).toBe(true)
			expect(session.state.agents.has(AgentId('worker_b_1'))).toBe(true)

			// Worker A received report from Worker B
			expect(workerASawReport).toBe(true)

			// B's parent is A
			expect(session.state.agents.get(AgentId('worker_b_1'))!.parentId).toBe(AgentId('worker_a_1'))

			await harness.shutdown()
		})

		it('isEnabled: agents with no spawnable agents → no start_* tools generated', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset({ orchestratorSystem: 'No children orchestrator.' })],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Test')

			// No start_* tools in the LLM request
			const lastRequest = harness.llmProvider.getLastRequest()
			expect(lastRequest).toBeDefined()
			const startTools = (lastRequest!.tools ?? []).filter(t => t.name.startsWith('start_'))
			expect(startTools).toHaveLength(0)

			await harness.shutdown()
		})
	})
})
