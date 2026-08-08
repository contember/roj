import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { LLMError } from '~/core/llm/provider.js'
import { definePlugin } from '~/core/plugins/index.js'
import { pluginWakeKey } from '~/core/plugins/wake-key.js'
import { ToolCallId } from '~/core/tools/schema.js'
import type { Platform, Scheduler } from '~/platform/index.js'
import { agentsPlugin } from '~/plugins/agents/plugin.js'
import { generateTestMessageId, mailboxEvents } from '~/plugins/mailbox/index.js'
import { createMultiAgentPreset, TestHarness, type TestSession } from '~/testing/index.js'
import { createNodePlatform } from '~/testing/node-platform.js'

/** Records wakes and never fires them — the shape of a host that wakes out-of-band. */
class RecordingScheduler implements Scheduler {
	readonly armed = new Map<string, number>()

	async wake(key: string, delayMs: number): Promise<void> {
		this.armed.set(key, delayMs)
	}

	async cancel(key: string): Promise<void> {
		this.armed.delete(key)
	}
}

const recordingPlatform = (): { platform: Platform; scheduler: RecordingScheduler } => {
	const scheduler = new RecordingScheduler()
	return { platform: { ...createNodePlatform(), scheduler }, scheduler }
}

/** Retryable, with a zero retry-after so the inner LLM retries burn no wall clock. */
const RATE_LIMITED: LLMError = { type: 'rate_limit', message: 'slow down', retryAfterMs: 0 }

/** Is this plugin-method call the supervision snapshot going out to a parent? */
function isSupervisorSend(method: string, input: unknown): boolean {
	if (method !== 'mailbox.send') return false
	return typeof input === 'object' && input !== null && 'fromSupervisor' in input && input.fromSupervisor === true
}

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

/** Count the supervision snapshots delivered so far. */
async function countSupervisorMessages(session: TestSession): Promise<number> {
	const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
	return events.filter((e) => e.message.from === 'supervisor').length
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

	it('the tick stops re-arming once every child is idle', async () => {
		let orchestratorCalls = 0

		const harness = new TestHarness({
			presets: [{
				...createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' }),
				plugins: [{ pluginName: 'agents', definition: agentsPlugin, config: { superviseChildrenIntervalMs: 30 } }],
			}],
			mockHandler: (request) => {
				if (request.systemPrompt.includes('Orchestrator')) {
					orchestratorCalls++
					if (orchestratorCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Quick task' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'noted', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				return { content: 'finished', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendMessage('Start')

		const orchestratorId = session.getEntryAgentId()!
		expect(await waitForSupervisorMessage(session, orchestratorId)).toBeDefined()

		// Children are never removed from session state, so a tick that re-armed on
		// "has children" would keep firing every 30ms for the life of the process.
		await new Promise((r) => setTimeout(r, 100))
		const settled = await countSupervisorMessages(session)
		await new Promise((r) => setTimeout(r, 300))
		expect(await countSupervisorMessages(session)).toBe(settled)

		await harness.shutdown()
	})

	it('the tick keeps firing while a child is still working', async () => {
		let orchestratorCalls = 0
		let releaseWorker = () => {}
		const workerGate = new Promise<void>((resolve) => {
			releaseWorker = resolve
		})

		const harness = new TestHarness({
			presets: [{
				...createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' }),
				plugins: [{ pluginName: 'agents', definition: agentsPlugin, config: { superviseChildrenIntervalMs: 30 } }],
			}],
			mockHandler: async (request) => {
				if (request.systemPrompt.includes('Orchestrator')) {
					orchestratorCalls++
					if (orchestratorCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Slow task' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'noted', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				// Worker stays in 'inferring' until the test releases it.
				await workerGate
				return { content: 'finally done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendMessage('Start')

		const orchestratorId = session.getEntryAgentId()!
		expect(await waitForSupervisorMessage(session, orchestratorId)).toBeDefined()

		await new Promise((r) => setTimeout(r, 200))
		expect(await countSupervisorMessages(session)).toBeGreaterThan(2)

		releaseWorker()
		await session.waitForIdle()
		await harness.shutdown()
	})

	it('supervision holds no lease while waiting, so an idle runtime is evictable', async () => {
		let orchestratorCalls = 0

		const harness = new TestHarness({
			sessionIdleTimeoutMs: 20,
			presets: [{
				...createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' }),
				// Far beyond the test window — the timer is armed the whole time.
				plugins: [{ pluginName: 'agents', definition: agentsPlugin, config: { superviseChildrenIntervalMs: 5000 } }],
			}],
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
					return { content: 'noted', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				return { content: 'done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Start')

		const deadline = Date.now() + 2000
		while (Date.now() < deadline && harness.sessionManager.getRuntimeCacheStats().loadedSessionCount > 0) {
			await new Promise((r) => setTimeout(r, 10))
		}
		expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)

		await harness.shutdown()
	})

	it('a child that errored and is retrying itself still counts as working', async () => {
		let orchestratorCalls = 0
		let workerCalls = 0
		let releaseWorker = () => {}
		const workerGate = new Promise<void>((resolve) => {
			releaseWorker = resolve
		})

		const harness = new TestHarness({
			presets: [{
				...createMultiAgentPreset([
					{
						name: 'worker',
						system: 'Worker agent.',
						tools: [],
						agents: [],
						// One short outer backoff, then the worker recovers on its own.
						errorResumeBackoff: { baseDelayMs: 300, maxDelayMs: 300 },
					},
				], { orchestratorSystem: 'Orchestrator agent.' }),
				plugins: [{ pluginName: 'agents', definition: agentsPlugin, config: { superviseChildrenIntervalMs: 60 } }],
			}],
			mockHandler: async (request) => {
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
					return { content: 'noted', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				workerCalls++
				// Burn the inner withLLMRetry budget so the worker lands in 'errored' with
				// its dequeue token preserved — decide() will call that resume_from_error.
				if (workerCalls <= 5) throw RATE_LIMITED
				await workerGate
				return { content: 'finally done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendMessage('Start')

		const orchestratorId = session.getEntryAgentId()!
		expect(await waitForSupervisorMessage(session, orchestratorId)).toBeDefined()

		// 'errored' is not idle: the agent holds a live retry timer and comes back on its
		// own. Treating it as idle stopped supervision permanently — nothing re-arms when
		// a child transitions idle→busy by itself, and the parent has nothing to infer
		// about because it is waiting on that child.
		const workerStatus = () =>
			[...session.state.agents.values()].find((a) => a.definitionName === 'worker')?.status
		const recoveredBy = Date.now() + 3000
		while (Date.now() < recoveredBy && workerStatus() !== 'inferring') {
			await new Promise((r) => setTimeout(r, 10))
		}
		expect(workerStatus()).toBe('inferring')

		// The child is now provably working; supervision must still be delivering.
		const afterRecovery = await countSupervisorMessages(session)
		await new Promise((r) => setTimeout(r, 400))
		expect(await countSupervisorMessages(session)).toBeGreaterThan(afterRecovery)

		releaseWorker()
		await harness.shutdown()
	})

	it('the re-arm gate reads state as of after the snapshot send, not before it', async () => {
		let orchestratorCalls = 0
		let workerCalls = 0
		let woken = false
		let releaseWorker = () => {}
		let releaseOrchestrator = () => {}
		const workerGate = new Promise<void>((resolve) => {
			releaseWorker = resolve
		})
		const orchestratorGate = new Promise<void>((resolve) => {
			releaseOrchestrator = resolve
		})

		// Wakes the child from inside the tick's own await window: beforeMethod runs after
		// _supervisionTick captured ctx.sessionState and before its re-arm gate.
		const wakeChildPlugin = definePlugin('test-wake-child')
			.sessionHook('beforeMethod', async (ctx) => {
				if (woken || !isSupervisorSend(ctx.method, ctx.input)) return null
				const worker = [...ctx.getSessionState().agents.values()].find((a) => a.definitionName === 'worker')
				if (!worker) return null
				woken = true
				await ctx.emitEvent(mailboxEvents.create('mailbox_message', {
					toAgentId: worker.id,
					message: {
						id: generateTestMessageId(),
						from: 'user',
						content: 'One more thing',
						timestamp: Date.now(),
						consumed: false,
					},
				}))
				ctx.scheduleAgent(worker.id)
				return null
			})
			.build()

		const harness = new TestHarness({
			presets: [{
				...createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' }),
				plugins: [
					{ pluginName: 'agents', definition: agentsPlugin, config: { superviseChildrenIntervalMs: 200 } },
					wakeChildPlugin.configure(),
				],
			}],
			mockHandler: async (request) => {
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
					// The parent never finishes another turn, so afterInference cannot be the
					// thing that re-arms — only the tick's own gate can.
					await orchestratorGate
					return { content: 'noted', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				workerCalls++
				if (workerCalls === 1) {
					return { content: 'done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				await workerGate
				return { content: 'done again', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendMessage('Start')

		// The parent stays inside its blocked second turn, so waitForIdle would never
		// return; wait for the state the tick has to observe instead — the child idle
		// again after its first turn.
		const workerIdleBy = Date.now() + 3000
		const workerStatus = () =>
			[...session.state.agents.values()].find((a) => a.definitionName === 'worker')?.status
		while (Date.now() < workerIdleBy && !(workerCalls >= 1 && workerStatus() === 'pending')) {
			await new Promise((r) => setTimeout(r, 5))
		}
		expect(workerStatus()).toBe('pending')

		const deadline = Date.now() + 3000
		while (Date.now() < deadline && await countSupervisorMessages(session) < 3) {
			await new Promise((r) => setTimeout(r, 25))
		}
		expect(woken).toBe(true)
		expect(await countSupervisorMessages(session)).toBeGreaterThanOrEqual(3)

		releaseWorker()
		releaseOrchestrator()
		await harness.shutdown()
	})

	it('a paused parent gets no snapshots it cannot consume', async () => {
		let orchestratorCalls = 0
		let releaseWorker = () => {}
		const workerGate = new Promise<void>((resolve) => {
			releaseWorker = resolve
		})

		const harness = new TestHarness({
			presets: [{
				...createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' }),
				plugins: [{ pluginName: 'agents', definition: agentsPlugin, config: { superviseChildrenIntervalMs: 50 } }],
			}],
			mockHandler: async (request) => {
				if (request.systemPrompt.includes('Orchestrator')) {
					orchestratorCalls++
					if (orchestratorCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Slow task' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'noted', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				await workerGate
				return { content: 'finally done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendMessage('Start')

		const orchestratorId = session.getEntryAgentId()!
		expect(await waitForSupervisorMessage(session, orchestratorId)).toBeDefined()

		// A paused parent cannot consume anything: every further snapshot just queues up
		// and lands on it in one pile when it resumes.
		await session.pauseAgent(orchestratorId)
		await new Promise((r) => setTimeout(r, 60))
		const whilePaused = await countSupervisorMessages(session)

		await new Promise((r) => setTimeout(r, 400))
		expect(await countSupervisorMessages(session)).toBe(whilePaused)

		releaseWorker()
		await harness.shutdown()
	})

	it('supervision resumes after an idle eviction rebuilds the runtime', async () => {
		let orchestratorCalls = 0

		const harness = new TestHarness({
			sessionIdleTimeoutMs: 150,
			presets: [{
				...createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' }),
				plugins: [{ pluginName: 'agents', definition: agentsPlugin, config: { superviseChildrenIntervalMs: 60 } }],
			}],
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
					return { content: 'noted', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				return { content: 'done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Start')

		const evictedBy = Date.now() + 5000
		while (Date.now() < evictedBy && harness.sessionManager.getRuntimeCacheStats().loadedSessionCount > 0) {
			await new Promise((r) => setTimeout(r, 10))
		}
		expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
		const beforeReload = await countSupervisorMessages(session)

		// The claim the lease-inside-the-tick comment makes: onSessionReady re-arms once
		// the runtime is rebuilt, so an eviction only pauses supervision.
		const reopened = await harness.openSession(session.sessionId)
		const deadline = Date.now() + 3000
		while (Date.now() < deadline && await countSupervisorMessages(reopened) <= beforeReload) {
			await new Promise((r) => setTimeout(r, 10))
		}
		expect(await countSupervisorMessages(reopened)).toBeGreaterThan(beforeReload)

		await harness.shutdown()
	})

	it('a tick that lands on an unloading runtime is delivered once it is rebuilt', async () => {
		let orchestratorCalls = 0
		let closeStarted = false

		// Runs first in performDisposal's reversed plugin order, so the runtime sits in
		// 'unloading' — the wake still pending — for as long as this blocks.
		const slowClosePlugin = definePlugin('test-slow-close')
			.sessionHook('onSessionClose', async () => {
				closeStarted = true
				await new Promise((r) => setTimeout(r, 400))
			})
			.build()

		const harness = new TestHarness({
			sessionIdleTimeoutMs: 40,
			presets: [{
				...createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' }),
				plugins: [
					{ pluginName: 'agents', definition: agentsPlugin, config: { superviseChildrenIntervalMs: 150 } },
					slowClosePlugin.configure(),
				],
			}],
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
					return { content: 'noted', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				}
				return { content: 'done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Start')

		const closingBy = Date.now() + 5000
		while (Date.now() < closingBy && !closeStarted) {
			await new Promise((r) => setTimeout(r, 5))
		}
		expect(closeStarted).toBe(true)
		const duringUnload = await countSupervisorMessages(session)

		// The wake carries no closure, so the runtime that armed it going away does not
		// lose it: dispatch rebuilds the session from its log and the snapshot lands there.
		const deadline = Date.now() + 5000
		while (Date.now() < deadline && await countSupervisorMessages(session) <= duringUnload) {
			await new Promise((r) => setTimeout(r, 10))
		}
		expect(await countSupervisorMessages(session)).toBeGreaterThan(duringUnload)

		await harness.shutdown()
	})

	it('a tick armed in one process is delivered by another, from the key alone', async () => {
		const sharedEventStore = new (await import('~/core/events/memory.js')).MemoryEventStore()
		let orchestratorCalls = 0

		const buildHarness = (intervalMs: number | undefined, platform?: Platform) =>
			new TestHarness({
				eventStore: sharedEventStore,
				...(platform && { platform }),
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

		// Process 1: supervision off, so it only leaves a parent with a child behind.
		const first = buildHarness(undefined)
		const session1 = await first.createSession('test')
		await session1.sendAndWaitForIdle('Start')
		const sessionId = session1.sessionId
		await first.shutdown()

		// Process 2: supervision on, wakes held by the host rather than by a timer.
		const { platform, scheduler } = recordingPlatform()
		const second = buildHarness(240_000, platform)
		const session2 = await second.openSession(sessionId)
		const orchestratorId = session2.getEntryAgentId()!

		const key = pluginWakeKey(sessionId, 'agents', '_supervisionTick', orchestratorId)
		expect(scheduler.armed.get(key)).toBe(240_000)

		// Nothing but the key: dispatch re-derives the plugin, the method and the agent.
		scheduler.armed.clear()
		await second.sessionManager.dispatchWake(key)

		const msg = await waitForSupervisorMessage(session2, orchestratorId, 500)
		expect(msg).toBeDefined()
		expect(msg!.message.content).toContain('worker_1')
		// The worker is idle by now, so the re-arm gate closes. Rolling re-arm while a
		// child is still working is covered by 'the tick keeps firing' above.
		expect(scheduler.armed.has(key)).toBe(false)

		await second.shutdown()
	})
})
