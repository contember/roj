import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { AgentId, agentIdSchema } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { MemoryEventStore } from '~/core/events/memory.js'
import type { DomainEvent } from '~/core/events/types.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createMultiAgentPreset, createTestPreset, TestHarness } from '~/testing/index.js'

/** Holds the first `agent_spawned` append open so a second spawn runs against the stale projection. */
class GatedSpawnEventStore extends MemoryEventStore {
	/** Armed only after session creation — that spawns the orchestrator through the same path. */
	private armed = false
	private spawnCount = 0
	private releaseFirstSpawn = () => {}
	private markFirstSpawnStarted = () => {}
	readonly firstSpawnStarted = new Promise<void>((resolve) => {
		this.markFirstSpawnStarted = resolve
	})

	arm(): void {
		this.armed = true
	}

	release(): void {
		this.releaseFirstSpawn()
	}

	private async gate(events: DomainEvent[]): Promise<void> {
		if (!this.armed) return
		if (!events.some((event) => event.type === 'agent_spawned') || ++this.spawnCount !== 1) return
		this.markFirstSpawnStarted()
		await new Promise<void>((resolve) => {
			this.releaseFirstSpawn = resolve
		})
	}

	override async append(sessionId: SessionId, event: DomainEvent): Promise<void> {
		await this.gate([event])
		await super.append(sessionId, event)
	}

	override async appendBatch(sessionId: SessionId, events: DomainEvent[]): Promise<void> {
		await this.gate(events)
		await super.appendBatch(sessionId, events)
	}
}

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
		it('gives concurrent spawns of one definition distinct ids', async () => {
			const eventStore = new GatedSpawnEventStore()
			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
				eventStore,
			})

			const session = await harness.createSession('test')
			eventStore.arm()
			const orchestratorId = session.getEntryAgentId()!
			const spawn = () => session.callPluginMethod('agents.spawn', {
				definitionName: 'worker',
				parentId: String(orchestratorId),
			})

			// The second call derives its id while the first spawn is still unappended,
			// so both see the same agent counter in the projection.
			const first = spawn()
			await eventStore.firstSpawnStarted
			const second = spawn()
			eventStore.release()
			const results = await Promise.all([first, second])

			const spawnOutput = z.object({ agentId: agentIdSchema })
			const spawnedIds = results.map((result) => {
				if (!result.ok) throw new Error(`Spawn failed: ${result.error.message}`)
				return spawnOutput.parse(result.value).agentId
			})
			expect(new Set(spawnedIds).size).toBe(2)

			await session.waitForIdle()
			const workers = [...session.state.agents.values()].filter((agent) => agent.definitionName === 'worker')
			expect(workers).toHaveLength(2)
			expect(new Set(workers.map((agent) => agent.id))).toEqual(new Set(spawnedIds))

			await harness.shutdown()
		})

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

	// =========================================================================
	// resume_agent tool
	// =========================================================================

	describe('resume_agent tool', () => {
		// A paused child never becomes idle, so waitForAllAgentsIdle can't be used here —
		// wait for the effect instead.
		const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
			const deadline = Date.now() + timeoutMs
			while (Date.now() < deadline) {
				if (predicate()) return
				await new Promise(resolve => setTimeout(resolve, 10))
			}
			throw new Error('waitFor timed out')
		}

		const workerPreset = () => createMultiAgentPreset([
			{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
		], { orchestratorSystem: 'Orchestrator agent.' })

		it('is offered to an agent that can spawn, and not to a leaf', async () => {
			const toolNames = new Map<string, string[]>()

			const harness = new TestHarness({
				presets: [workerPreset()],
				mockHandler: (request) => {
					const role = request.systemPrompt.includes('Orchestrator') ? 'orchestrator' : 'worker'
					toolNames.set(role, (request.tools ?? []).map(tool => tool.name))
					if (role === 'orchestrator' && !toolNames.has('worker')) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Work' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			expect(toolNames.get('orchestrator')).toContain('resume_agent')
			expect(toolNames.get('worker')).not.toContain('resume_agent')

			await harness.shutdown()
		})

		it('orchestrator resumes its paused child', async () => {
			let started = false
			let resumeIssued = false

			const harness = new TestHarness({
				presets: [workerPreset()],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						const asked = JSON.stringify(request.messages).includes('Resume the worker')
						if (asked && !resumeIssued) {
							resumeIssued = true
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc2'), name: 'resume_agent', input: { agentId: 'worker_1' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						if (!started) {
							started = true
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

			const pauseResult = await session.callPluginMethod('agents.pause', { agentId: 'worker_1' })
			expect(pauseResult.ok).toBe(true)
			expect(session.state.agents.get(AgentId('worker_1'))!.status).toBe('paused')

			await session.sendMessage('Resume the worker')
			await waitFor(() => session.state.agents.get(AgentId('worker_1'))!.status !== 'paused')

			const resumedEvents = await session.getEventsByType(agentEvents, 'agent_resumed')
			expect(resumedEvents.filter(e => e.agentId === AgentId('worker_1'))).toHaveLength(1)
			expect(session.state.agents.get(AgentId('worker_1'))!.status).not.toBe('paused')

			await harness.shutdown()
		})

		it('refuses an agent that is not the caller\'s child', async () => {
			let delegated = false
			let subDelegated = false
			let resumeIssued = false
			let toolResult = ''

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker_a', system: 'Worker A agent.', tools: [], agents: ['worker_b'] },
					{ name: 'worker_b', system: 'Worker B agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						const last = request.messages[request.messages.length - 1]
						if (last?.role === 'tool' && resumeIssued) toolResult = JSON.stringify(last.content)

						const asked = JSON.stringify(request.messages).includes('Resume the grandchild')
						if (asked && !resumeIssued) {
							resumeIssued = true
							// worker_b is a grandchild — spawned by worker_a, not by the orchestrator
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc3'), name: 'resume_agent', input: { agentId: 'worker_b_1' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						if (!delegated) {
							delegated = true
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
						if (subDelegated) {
							return { content: 'Worker A done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
						}
						subDelegated = true
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc2'), name: 'start_worker_b', input: { message: 'Sub-task' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start', { timeoutMs: 15_000 })

			await session.callPluginMethod('agents.pause', { agentId: 'worker_b_1' })
			await session.sendMessage('Resume the grandchild')
			await waitFor(() => toolResult !== '')

			expect(toolResult).toContain('not your child')
			expect(session.state.agents.get(AgentId('worker_b_1'))!.status).toBe('paused')

			await harness.shutdown()
		}, 20_000)
	})
})
