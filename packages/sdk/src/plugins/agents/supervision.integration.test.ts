import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { agentsPlugin } from '~/plugins/agents/plugin.js'
import { mailboxEvents } from '~/plugins/mailbox/index.js'
import { createMultiAgentPreset, TestHarness, type TestSession } from '~/testing/index.js'

/**
 * Helper — wait until at least one supervision message has landed in the parent's
 * mailbox (or timeout). We poll because supervision ticks fire on real timers.
 */
async function waitForSupervisorMessage(
	session: TestSession,
	toAgentId: AgentId,
	timeoutMs = 2000,
): Promise<{ message: { from: unknown; content: string } } | undefined> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
		const found = events.find((e) =>
			e.message.from === 'supervisor'
			&& e.toAgentId === toAgentId
			&& typeof e.message.content === 'string',
		)
		if (found) return found
		await new Promise((r) => setTimeout(r, 25))
	}
	return undefined
}

describe('agents plugin supervision', () => {
	it('parent with active children receives a periodic <children-status> snapshot', async () => {
		let orchestratorCalls = 0
		let workerCalls = 0

		const harness = new TestHarness({
			presets: [{
				...createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' }),
				plugins: [{ pluginName: 'agents', definition: agentsPlugin, config: { superviseChildrenIntervalMs: 100 } }],
			}],
			mockHandler: (request) => {
				if (request.systemPrompt.includes('Orchestrator')) {
					orchestratorCalls++
					if (orchestratorCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Long-running task' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					// Subsequent calls: orchestrator does nothing more, just acknowledges.
					return { content: 'noted', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				// Worker: takes a long time — say something but never reports back.
				workerCalls++
				return { content: `Working on step ${workerCalls}`, toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendMessage('Start')

		// Orchestrator is the entry agent in this preset. Wait for a tick.
		const orchestratorId = session.getEntryAgentId()!
		const supervisorMsg = await waitForSupervisorMessage(session as never, orchestratorId)

		expect(supervisorMsg).toBeDefined()
		expect(supervisorMsg!.message.content).toContain('<children-status>')
		expect(supervisorMsg!.message.content).toContain('worker_1')
		// Cumulative LLM call count should be present
		expect(supervisorMsg!.message.content).toMatch(/worker_1[^,\n]*,[^,\n]*,\s*\d+ tools,\s*\d+ llm/)

		await harness.shutdown()
	})

	it('default (no config) → supervision disabled, no tick fires', async () => {
		const harness = new TestHarness({
			presets: [createMultiAgentPreset([
				{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
			], { orchestratorSystem: 'Orchestrator agent.' })],
			mockHandler: (request) => {
				if (request.systemPrompt.includes('Orchestrator')) {
					return {
						content: null,
						toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Do work' } }],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				}
				return { content: 'Working', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendMessage('Start')

		// Wait long enough for ticks if they were enabled (they shouldn't).
		await new Promise((r) => setTimeout(r, 300))

		const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
		const supervisorMessages = events.filter(e => e.message.from === 'supervisor')
		expect(supervisorMessages).toHaveLength(0)

		await harness.shutdown()
	})

	it('parent without children → no tick fires', async () => {
		const harness = new TestHarness({
			presets: [{
				...createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' }),
				plugins: [{ pluginName: 'agents', definition: agentsPlugin, config: { superviseChildrenIntervalMs: 100 } }],
			}],
			mockHandler: (request) => {
				// Orchestrator never spawns anyone.
				if (request.systemPrompt.includes('Orchestrator')) {
					return { content: 'Done without spawning', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				return { content: 'unused', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Start')

		// Give supervision plenty of room to fire (it shouldn't).
		await new Promise((r) => setTimeout(r, 300))

		const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
		const supervisorMessages = events.filter(e => e.message.from === 'supervisor')
		expect(supervisorMessages).toHaveLength(0)

		await harness.shutdown()
	})

	it('snapshot includes "first words..last words" preview of last assistant turn', async () => {
		let orchestratorCalls = 0

		const harness = new TestHarness({
			presets: [{
				...createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' }),
				plugins: [{ pluginName: 'agents', definition: agentsPlugin, config: { superviseChildrenIntervalMs: 100 } }],
			}],
			mockHandler: (request) => {
				if (request.systemPrompt.includes('Orchestrator')) {
					orchestratorCalls++
					if (orchestratorCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Long task' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'ack', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				// Worker says a long sentence that should be truncated to first..last words
				return {
					content: 'Started fetching data and now I am running through the pipeline analyzing the response carefully',
					toolCalls: [],
					finishReason: 'stop',
					metrics: MockLLMProvider.defaultMetrics(),
				}
			},
		})

		const session = await harness.createSession('test')
		await session.sendMessage('Start')

		const orchestratorId = session.getEntryAgentId()!
		const msg = await waitForSupervisorMessage(session as never, orchestratorId)

		expect(msg).toBeDefined()
		// Should contain both head (first 5 words) and tail (last 5 words), joined by ".."
		expect(msg!.message.content).toContain('Started fetching data and now')
		expect(msg!.message.content).toContain('pipeline analyzing the response carefully')
		expect(msg!.message.content).toMatch(/\.\.pipeline/)

		await harness.shutdown()
	})

	it('server restart re-establishes timers via onSessionReady', async () => {
		const sharedEventStore = new (await import('~/core/events/memory.js')).MemoryEventStore()

		// Counter shared across phases — phase 1 spawns once, then orchestrator goes idle;
		// phase 2 just acknowledges any wake-up triggered by the supervision tick.
		let orchestratorCalls = 0

		const buildHarness = (intervalMs: number | undefined) => new TestHarness({
			eventStore: sharedEventStore,
			presets: [{
				...createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' }),
				...(intervalMs !== undefined && {
					plugins: [{ pluginName: 'agents', definition: agentsPlugin, config: { superviseChildrenIntervalMs: intervalMs } }],
				}),
			}],
			mockHandler: (request) => {
				if (request.systemPrompt.includes('Orchestrator')) {
					orchestratorCalls++
					if (orchestratorCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Long task' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'noted', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				return { content: 'still working', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		// Phase 1: create session with supervision DISABLED (default) so no ticks pre-restart.
		const harness1 = buildHarness(undefined)
		const session1 = await harness1.createSession('test')
		await session1.sendAndWaitForIdle('Start')
		const hasWorker = () => {
			for (const agent of session1.state.agents.values()) {
				if (agent.definitionName === 'worker') return true
			}
			return false
		}
		expect(hasWorker()).toBe(true)
		const sessionId = session1.sessionId
		await harness1.shutdown()

		// Phase 2: restart with supervision enabled. onSessionReady should
		// re-arm the orchestrator's tick because it has a child.
		const harness2 = buildHarness(100)
		const session2 = await harness2.openSession(sessionId)

		const orchestratorId = session2.getEntryAgentId()!
		const msg = await waitForSupervisorMessage(session2, orchestratorId, 1500)
		expect(msg).toBeDefined()
		expect(msg!.message.content).toContain('worker_1')

		await harness2.shutdown()
	})
})
