import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { MemoryEventStore } from '~/core/events/memory.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { DomainEvent } from '~/core/events/types.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { generateMessageId } from '~/plugins/mailbox/schema.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { createWorkerDefinition, MAX_CONCURRENT_WORKERS, WORKER_STOP_TIMEOUT_MS, workerEvents, workerPlugin } from './index.js'
import { type WorkerEntry, WorkerId } from './worker.js'

// ============================================================================
// Test Worker Definitions
// ============================================================================

/** A simple worker that completes immediately with a result. */
const immediateWorker = createWorkerDefinition(
	'immediate',
	'Completes immediately',
	z.object({ value: z.string() }),
	{
		initialState: () => ({ count: 0 }),
		reduce: (state: { count: number }, event: { type: string }) => {
			if (event.type === 'increment') return { count: state.count + 1 }
			return state
		},
		execute: async (config) => {
			return Ok({
				status: 'done',
				summary: `Processed: ${config.value}`,
			})
		},
	},
)

/** A worker that fails with an error. */
const failingWorker = createWorkerDefinition(
	'failing',
	'Always fails',
	z.object({}),
	{
		initialState: () => ({}),
		reduce: (state: {}) => state,
		execute: async () => {
			return Err({ message: 'Worker error', resumable: true })
		},
	},
)

/** A worker that throws an exception. */
const throwingWorker = createWorkerDefinition(
	'throwing',
	'Throws exception',
	z.object({}),
	{
		initialState: () => ({}),
		reduce: (state: {}) => state,
		execute: async () => {
			throw new Error('Unexpected crash')
		},
	},
)

/** A worker that emits sub-events before completing. */
const emittingWorker = createWorkerDefinition(
	'emitting',
	'Emits sub-events',
	z.object({}),
	{
		initialState: () => ({ items: [] as string[] }),
		reduce: (state: { items: string[] }, event: { type: string; item?: string }) => {
			if (event.type === 'item_added' && event.item) {
				return { items: [...state.items, event.item] }
			}
			return state
		},
		execute: async (_config, ctx) => {
			await ctx.emit({ type: 'item_added', item: 'alpha' })
			await ctx.emit({ type: 'item_added', item: 'beta' })
			return Ok({ status: 'done', summary: 'Emitted 2 items' })
		},
	},
)

/** A deferred worker that waits for cancellation. */
function createDeferredWorker() {
	let resolveWorker: (() => void) | undefined
	const started = new Promise<void>((r) => {
		resolveWorker = undefined // placeholder
		void r // will be set below
	})
	let startedResolve: () => void
	const startedPromise = new Promise<void>((r) => {
		startedResolve = r
	})

	const worker = createWorkerDefinition(
		'deferred',
		'Waits until cancelled or resolved',
		z.object({}),
		{
			initialState: () => ({}),
			reduce: (state: {}) => state,
			execute: async (_config, ctx) => {
				startedResolve()
				// Poll for cancellation
				while (ctx.shouldContinue()) {
					await new Promise((r) => setTimeout(r, 10))
				}
				return Ok({ status: 'cancelled', summary: 'Worker was cancelled' })
			},
		},
	)
	return { worker, started: startedPromise }
}

/** A worker that writes a file. */
const artifactWorker = createWorkerDefinition(
	'artifact',
	'Writes files',
	z.object({}),
	{
		initialState: () => ({}),
		reduce: (state: {}) => state,
		execute: async (_config, ctx) => {
			const written = await ctx.files.write('output.html', '<h1>Hello</h1>')
			if (!written.ok) return Err({ message: `Failed to write file: ${written.error}`, resumable: true })
			return Ok({ status: 'done', summary: 'Wrote file' })
		},
	},
)

/** A worker that notifies the agent. */
const notifyingWorker = createWorkerDefinition(
	'notifying',
	'Notifies agent',
	z.object({}),
	{
		initialState: () => ({}),
		reduce: (state: {}) => state,
		execute: async (_config, ctx) => {
			await ctx.notifyAgent('Progress update: 50%')
			return Ok({ status: 'done', summary: 'Notified agent' })
		},
	},
)

/** A worker with command support. */
const commandWorker = createWorkerDefinition(
	'commandable',
	'Supports commands',
	z.object({}),
	{
		commands: {
			update_config: {
				description: 'Update config',
				schema: z.object({ key: z.string() }),
			},
		},
		initialState: () => ({ commandsReceived: 0 }),
		reduce: (state: { commandsReceived: number }, event: { type: string }) => {
			if (event.type === 'command_received') return { commandsReceived: state.commandsReceived + 1 }
			return state
		},
		execute: async (_config, ctx) => {
			// Wait a bit for commands to arrive
			while (ctx.shouldContinue()) {
				await new Promise((r) => setTimeout(r, 10))
			}
			return Ok({ status: 'done', summary: 'Done' })
		},
		handleCommand: async (cmd, ctx) => {
			await ctx.emit({ type: 'command_received' })
			return Ok(`Command ${cmd.command} handled`)
		},
	},
)

// ============================================================================
// Helpers
// ============================================================================

const allWorkers = [immediateWorker, failingWorker, throwingWorker, emittingWorker, artifactWorker, notifyingWorker, commandWorker]

function createWorkersPreset(overrides?: Parameters<typeof createTestPreset>[0]) {
	return createTestPreset({
		...overrides,
		plugins: [
			workerPlugin.configure({ workers: allWorkers }),
			...(overrides?.plugins ?? []),
		],
	})
}

function createWorkersHarness(options: Omit<ConstructorParameters<typeof TestHarness>[0], 'systemPlugins'>) {
	return new TestHarness({ ...options, systemPlugins: [workerPlugin] })
}

class GatedWorkerEffectEventStore extends MemoryEventStore {
	private readonly startedTypes = new Set<string>()
	private readonly completedTypes = new Set<string>()
	private markEffectsStarted = () => {}
	private releaseEffects = () => {}
	private readonly effectGate = new Promise<void>((resolve) => {
		this.releaseEffects = resolve
	})
	readonly effectsStarted = new Promise<void>((resolve) => {
		this.markEffectsStarted = resolve
	})

	release(): void {
		this.releaseEffects()
	}

	hasCompleted(type: string): boolean {
		return this.completedTypes.has(type)
	}

	override async append(sessionId: SessionId, event: DomainEvent): Promise<void> {
		if (event.type === 'worker_sub_event' || event.type === 'mailbox_message' || event.type === 'worker_completed') {
			this.startedTypes.add(event.type)
			if (this.startedTypes.size === 3) this.markEffectsStarted()
			await this.effectGate
			await super.append(sessionId, event)
			this.completedTypes.add(event.type)
			return
		}
		await super.append(sessionId, event)
	}
}

/** Event store that parks appends of the armed event types until `release()`. */
class ArmedGateEventStore extends MemoryEventStore {
	private armedTypes: ReadonlySet<string> = new Set()
	private releaseGate: () => void = () => {}
	private gate: Promise<void> = Promise.resolve()
	private markReached: () => void = () => {}

	/** Park every append of `types` from now on; the returned promise resolves once one is parked. */
	arm(types: readonly string[]): Promise<void> {
		this.armedTypes = new Set(types)
		this.gate = new Promise<void>((resolve) => {
			this.releaseGate = resolve
		})
		return new Promise<void>((resolve) => {
			this.markReached = resolve
		})
	}

	release(): void {
		this.armedTypes = new Set()
		this.releaseGate()
	}

	override async append(sessionId: SessionId, event: DomainEvent): Promise<void> {
		if (this.armedTypes.has(event.type)) {
			this.markReached()
			await this.gate
		}
		await super.append(sessionId, event)
	}
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

function createGatedWorker() {
	let markStarted = () => {}
	let finishExecution = () => {}
	const started = new Promise<void>((resolve) => {
		markStarted = resolve
	})
	const finish = new Promise<void>((resolve) => {
		finishExecution = resolve
	})
	const large = 'x'.repeat(100_000)
	const resumedRuns: boolean[] = []
	const worker = createWorkerDefinition(
		'gated',
		'Waits for an explicit test gate',
		z.object({ input: z.string() }),
		{
			initialState: (config) => ({ retainedWhileRunning: config.input }),
			reduce: (state: { retainedWhileRunning: string }) => state,
			execute: async (_config, ctx) => {
				resumedRuns.push(ctx.resumed)
				markStarted()
				await finish
				return Ok({
					status: 'done',
					summary: 'Gated worker completed',
					resultsPath: 'result.json',
					data: { large },
				})
			},
		},
	)
	return { worker, started, finish: finishExecution, large, resumedRuns }
}

/** A worker that records every execute() entry, then polls until it is stopped. */
function createResumableWorker() {
	const runs: Array<{ resumed: boolean; ticks: number }> = []
	const worker = createWorkerDefinition(
		'resumable',
		'Records each execute() entry',
		z.object({}),
		{
			commands: {
				ping: { description: 'Ping the worker', schema: z.object({}) },
			},
			initialState: () => ({ ticks: 0 }),
			reduce: (state: { ticks: number }, event: { type: string }) => (
				event.type === 'tick' ? { ticks: state.ticks + 1 } : state
			),
			execute: async (_config, ctx) => {
				runs.push({ resumed: ctx.resumed, ticks: ctx.getState().ticks })
				await ctx.emit({ type: 'tick' })
				while (ctx.shouldContinue()) {
					await new Promise((r) => setTimeout(r, 5))
				}
				return Ok({ status: 'stopped', summary: 'Stopped' })
			},
			handleCommand: async () => Ok('pong'),
		},
	)
	return { worker, runs }
}

/** A worker that ignores the stop signal until the test releases it. */
function createUnstoppableWorker() {
	let markStarted = () => {}
	let releaseBody = () => {}
	const started = new Promise<void>((resolve) => {
		markStarted = resolve
	})
	const bodyGate = new Promise<void>((resolve) => {
		releaseBody = resolve
	})
	const runs: boolean[] = []
	const worker = createWorkerDefinition(
		'unstoppable',
		'Ignores the stop signal until released',
		z.object({}),
		{
			initialState: () => ({ entered: 0 }),
			reduce: (state: { entered: number }) => state,
			execute: async (_config, ctx) => {
				runs.push(ctx.resumed)
				markStarted()
				await bodyGate
				return Ok({ status: 'done', summary: 'Released' })
			},
		},
	)
	return { worker, started, release: () => releaseBody(), runs }
}

/** A worker that leaves an emitted effect in flight and then completes straight away. */
function createTerminalThenEffectsWorker() {
	let markStarted = () => {}
	const started = new Promise<void>((resolve) => {
		markStarted = resolve
	})
	const worker = createWorkerDefinition(
		'terminal-then-effects',
		'Completes while an emitted effect is still in flight',
		z.object({}),
		{
			initialState: () => ({ emitted: 0 }),
			reduce: (state: { emitted: number }, event: { type: string }) => (
				event.type === 'in_flight' ? { emitted: state.emitted + 1 } : state
			),
			execute: async (_config, ctx) => {
				void ctx.emit({ type: 'in_flight' })
				markStarted()
				return Ok({ status: 'done', summary: 'REAL RESULT' })
			},
		},
	)
	return { worker, started }
}

function createInFlightEffectsWorker() {
	let markStarted = () => {}
	let finishBody = () => {}
	const started = new Promise<void>((resolve) => {
		markStarted = resolve
	})
	const bodyGate = new Promise<void>((resolve) => {
		finishBody = resolve
	})
	const worker = createWorkerDefinition(
		'in-flight-effects',
		'Starts context side effects before close',
		z.object({}),
		{
			initialState: () => ({ emitted: 0 }),
			reduce: (state: { emitted: number }, event: { type: string }) => {
				return event.type === 'in_flight' ? { emitted: state.emitted + 1 } : state
			},
			execute: async (_config, ctx) => {
				void ctx.emit({ type: 'in_flight' })
				void ctx.notifyAgent('in-flight notification')
				markStarted()
				await bodyGate
				return Ok({ status: 'done', summary: 'Body released' })
			},
		},
	)
	return { worker, started, finishBody }
}

// ============================================================================
// Tests
// ============================================================================

describe('workers plugin', () => {
	// =========================================================================
	// Worker spawning
	// =========================================================================

	describe('worker spawning', () => {
		it('agent calls worker_immediate_start → worker_started event → worker in state', async () => {
			const harness = createWorkersHarness({
				presets: [createWorkersPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'worker_immediate_start',
							input: { value: 'test-data' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start worker')

			const startedEvents = await session.getEventsByType(workerEvents, 'worker_started')
			expect(startedEvents).toHaveLength(1)
			expect(startedEvents[0].workerType).toBe('immediate')
			expect(startedEvents[0].config).toEqual({ value: 'test-data' })

			await harness.shutdown()
		})

		it('spawn non-existent worker type → error returned to LLM', async () => {
			const harness = createWorkersHarness({
				presets: [createWorkersPreset()],
				mockHandler: (request) => {
					const callHistory = harness.llmProvider.getCallHistory()
					if (callHistory.length === 0) {
						return {
							content: null,
							toolCalls: [{
								id: ToolCallId('tc1'),
								name: 'worker_immediate_start',
								input: { value: 'test' },
							}],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			// Use a preset with no workers configured to test spawn via direct method
			const harnessNoWorkers = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({ workers: [] })],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harnessNoWorkers.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			const result = await session.callPluginMethod('workers.spawn', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				workerType: 'nonexistent',
				config: {},
			})
			expect(result.ok).toBe(false)

			await harnessNoWorkers.shutdown()
		})

		it('spawn with invalid config → validation error', async () => {
			const harness = createWorkersHarness({
				presets: [createWorkersPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!
			const result = await session.callPluginMethod('workers.spawn', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				workerType: 'immediate',
				config: { wrong_field: 123 },
			})
			expect(result.ok).toBe(false)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Worker completion and failure
	// =========================================================================

	describe('worker completion and failure', () => {
		it('holds a runtime lease through background execution and compacts terminal state', async () => {
			const gated = createGatedWorker()
			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({ workers: [gated.worker] })],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			const session = await harness.createSession('test')
			const agentId = session.getEntryAgentId()
			if (!agentId) throw new Error('Expected entry agent')

			const spawn = await session.callPluginMethod('workers.spawn', {
				sessionId: String(session.sessionId),
				agentId: String(agentId),
				workerType: 'gated',
				config: { input: gated.large },
			})
			expect(spawn.ok).toBe(true)
			if (!spawn.ok) throw new Error('Expected worker spawn to succeed')
			const parsed = z.object({ workerId: z.string() }).parse(spawn.value)
			await gated.started

			const activeRuntime = harness.sessionManager.getRuntimeCacheStats().sessions.find((entry) => entry.id === session.sessionId)
			expect(activeRuntime?.leaseReasons[`worker:${parsed.workerId}`]).toBe(1)

			gated.finish()
			await waitFor(() => {
				const runtime = harness.sessionManager.getRuntimeCacheStats().sessions.find((entry) => entry.id === session.sessionId)
				return runtime?.leaseReasons[`worker:${parsed.workerId}`] === undefined
			})

			const workers = selectPluginState<Map<WorkerId, WorkerEntry>>(session.state, 'workers')
			const entry = workers?.values().next().value
			expect(entry?.status).toBe('completed')
			expect(entry).not.toHaveProperty('config')
			expect(entry).not.toHaveProperty('state')
			expect(entry?.result).toEqual({
				status: 'done',
				resultsPath: 'result.json',
				summary: 'Gated worker completed',
			})
			expect(entry?.result).not.toHaveProperty('data')
			await harness.shutdown()
		})

		it('worker returns Ok → worker_completed event → status completed', async () => {
			const harness = createWorkersHarness({
				presets: [createWorkersPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'worker_immediate_start',
							input: { value: 'hello' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start worker')

			// Wait briefly for async worker completion
			await new Promise((r) => setTimeout(r, 100))

			const completedEvents = await session.getEventsByType(workerEvents, 'worker_completed')
			expect(completedEvents).toHaveLength(1)
			expect(completedEvents[0].result.summary).toBe('Processed: hello')

			// Verify state
			const workers = selectPluginState<Map<WorkerId, WorkerEntry>>(session.state, 'workers')!
			expect(workers.size).toBe(1)
			const worker = Array.from(workers.values())[0]
			expect(worker.status).toBe('completed')

			await harness.shutdown()
		})

		it('worker returns Err → worker_failed event → status failed, resumable flag', async () => {
			const harness = createWorkersHarness({
				presets: [createWorkersPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'worker_failing_start',
							input: {},
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start worker')
			await new Promise((r) => setTimeout(r, 100))

			const failedEvents = await session.getEventsByType(workerEvents, 'worker_failed')
			expect(failedEvents).toHaveLength(1)
			expect(failedEvents[0].error).toBe('Worker error')
			expect(failedEvents[0].resumable).toBe(true)

			const workers = selectPluginState<Map<WorkerId, WorkerEntry>>(session.state, 'workers')!
			const worker = Array.from(workers.values())[0]
			expect(worker.status).toBe('failed')
			const runtime = harness.sessionManager.getRuntimeCacheStats().sessions.find((entry) => entry.id === session.sessionId)
			expect(Object.keys(runtime?.leaseReasons ?? {}).filter((reason) => reason.startsWith('worker:'))).toHaveLength(0)

			await harness.shutdown()
		})

		it('worker throws exception → worker_failed event, resumable: false', async () => {
			const harness = createWorkersHarness({
				presets: [createWorkersPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'worker_throwing_start',
							input: {},
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start worker')
			await new Promise((r) => setTimeout(r, 100))

			const failedEvents = await session.getEventsByType(workerEvents, 'worker_failed')
			expect(failedEvents).toHaveLength(1)
			expect(failedEvents[0].error).toBe('Unexpected crash')
			expect(failedEvents[0].resumable).toBe(false)
			const runtime = harness.sessionManager.getRuntimeCacheStats().sessions.find((entry) => entry.id === session.sessionId)
			expect(Object.keys(runtime?.leaseReasons ?? {}).filter((reason) => reason.startsWith('worker:'))).toHaveLength(0)

			await harness.shutdown()
		})
	})

	describe('worker replay and recovery', () => {
		it('resumes a legacy running worker and compacts its new terminal projection', async () => {
			const gated = createGatedWorker()
			const eventStore = new MemoryEventStore()
			const preset = createTestPreset({
				plugins: [workerPlugin.configure({ workers: [gated.worker] })],
			})
			const firstHarness = createWorkersHarness({
				presets: [preset],
				eventStore,
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			const firstSession = await firstHarness.createSession('test')
			const sessionId = firstSession.sessionId
			const agentId = firstSession.getEntryAgentId()
			if (!agentId) throw new Error('Expected entry agent')
			await firstHarness.shutdown()

			const workerId = WorkerId('legacy-running-worker')
			await eventStore.append(sessionId, withSessionId(sessionId, workerEvents.create('worker_started', {
				workerId,
				agentId,
				workerType: 'gated',
				config: { input: gated.large },
			})))

			const secondHarness = createWorkersHarness({
				presets: [preset],
				eventStore,
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			const secondSession = await secondHarness.openSession(sessionId)
			await gated.started
			// The rebuilt runtime re-enters execute() from the top and says so.
			expect(gated.resumedRuns).toEqual([true])
			const running = selectPluginState<Map<WorkerId, WorkerEntry>>(secondSession.state, 'workers')?.get(workerId)
			expect(running?.status).toBe('running')
			expect(running).toHaveProperty('config')
			expect(running).toHaveProperty('state')

			gated.finish()
			await waitFor(() => {
				const current = selectPluginState<Map<WorkerId, WorkerEntry>>(secondSession.state, 'workers')?.get(workerId)
				return current?.status === 'completed'
			})
			const completed = selectPluginState<Map<WorkerId, WorkerEntry>>(secondSession.state, 'workers')?.get(workerId)
			expect(completed).not.toHaveProperty('config')
			expect(completed).not.toHaveProperty('state')
			expect(completed?.result?.summary).toBe('Gated worker completed')
			await secondHarness.shutdown()
		})

		it('parks a running worker the rebuilt runtime cannot relaunch', async () => {
			const resumable = createResumableWorker()
			const eventStore = new MemoryEventStore()
			const preset = createTestPreset({
				plugins: [workerPlugin.configure({ workers: [resumable.worker] })],
			})
			const firstHarness = createWorkersHarness({
				presets: [preset],
				eventStore,
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			const firstSession = await firstHarness.createSession('test')
			const sessionId = firstSession.sessionId
			const agentId = firstSession.getEntryAgentId()
			if (!agentId) throw new Error('Expected entry agent')
			await firstHarness.shutdown()

			// One worker type the preset no longer knows, plus one over the concurrency cap:
			// both relaunch failures used to leave the projection claiming `running` for ever.
			const ghostWorkerId = WorkerId('worker-with-missing-definition')
			await eventStore.append(sessionId, withSessionId(sessionId, workerEvents.create('worker_started', {
				workerId: ghostWorkerId,
				agentId,
				workerType: 'ghost',
				config: {},
			})))
			const cappedWorkerIds: WorkerId[] = []
			for (let i = 0; i <= MAX_CONCURRENT_WORKERS; i++) {
				const workerId = WorkerId(`capped-worker-${i}`)
				cappedWorkerIds.push(workerId)
				await eventStore.append(sessionId, withSessionId(sessionId, workerEvents.create('worker_started', {
					workerId,
					agentId,
					workerType: 'resumable',
					config: {},
				})))
			}

			const secondHarness = createWorkersHarness({
				presets: [preset],
				eventStore,
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			try {
				const secondSession = await secondHarness.openSession(sessionId)
				const workers = selectPluginState<Map<WorkerId, WorkerEntry>>(secondSession.state, 'workers')
				expect(workers?.get(ghostWorkerId)?.status).toBe('paused')
				const relaunched = cappedWorkerIds.filter((id) => workers?.get(id)?.status === 'running')
				const parked = cappedWorkerIds.filter((id) => workers?.get(id)?.status === 'paused')
				expect(relaunched).toHaveLength(MAX_CONCURRENT_WORKERS)
				expect(parked).toHaveLength(1)
				// Parked, not failed: the state that makes it resumable survived.
				expect(workers?.get(parked[0])).toHaveProperty('state')

				const command = await secondSession.callPluginMethod('workers.sendCommand', {
					sessionId: String(sessionId),
					agentId: String(agentId),
					workerId: String(ghostWorkerId),
					command: 'ping',
				})
				expect(command.ok).toBe(false)
				if (!command.ok) expect(command.error.message).toContain('resume it first')

				const resumed = await secondSession.callPluginMethod('workers.resume', {
					sessionId: String(sessionId),
					agentId: String(agentId),
					workerId: String(ghostWorkerId),
				})
				expect(resumed.ok).toBe(false)
				if (!resumed.ok) expect(resumed.error.message).toContain('Unknown worker type: ghost')
			} finally {
				await secondHarness.shutdown()
			}
		})
	})

	// =========================================================================
	// Worker sub-events and state reduction
	// =========================================================================

	describe('worker sub-events and state reduction', () => {
		it('worker emits sub-events and terminal projection releases reduced state', async () => {
			const harness = createWorkersHarness({
				presets: [createWorkersPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'worker_emitting_start',
							input: {},
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start worker')
			await new Promise((r) => setTimeout(r, 100))

			const subEvents = await session.getEventsByType(workerEvents, 'worker_sub_event')
			expect(subEvents).toHaveLength(2)
			expect(subEvents[0].subEvent.type).toBe('item_added')
			expect(subEvents[0].subEvent.item).toBe('alpha')
			expect(subEvents[1].subEvent.item).toBe('beta')

			// Terminal workers retain only compact completion metadata.
			const workers = selectPluginState<Map<WorkerId, WorkerEntry>>(session.state, 'workers')!
			const worker = Array.from(workers.values())[0]
			expect(worker.status).toBe('completed')
			expect(worker).not.toHaveProperty('state')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Worker control (pause/resume/cancel)
	// =========================================================================

	describe('worker control', () => {
		it('cancel running worker → status cancelled, shouldContinue returns false', async () => {
			const { worker: deferred, started } = createDeferredWorker()

			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({ workers: [deferred] })],
				})],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'worker_deferred_start',
							input: {},
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start worker')

			// Wait for worker to start executing
			await started

			// Get worker ID from state
			const workers = selectPluginState<Map<WorkerId, WorkerEntry>>(session.state, 'workers')!
			const workerId = Array.from(workers.keys())[0]

			// Cancel the worker
			const entryAgentId = session.getEntryAgentId()!
			const result = await session.callPluginMethod('workers.cancel', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				workerId: String(workerId),
			})
			expect(result.ok).toBe(true)

			// Wait for worker to finish
			await new Promise((r) => setTimeout(r, 200))

			const statusEvents = await session.getEventsByType(workerEvents, 'worker_status_changed')
			const cancelEvent = statusEvents.find((e) => e.toStatus === 'cancelled')
			expect(cancelEvent).toBeDefined()
			expect(await session.getEventsByType(workerEvents, 'worker_completed')).toHaveLength(0)
			const runtime = harness.sessionManager.getRuntimeCacheStats().sessions.find((entry) => entry.id === session.sessionId)
			expect(Object.keys(runtime?.leaseReasons ?? {}).filter((reason) => reason.startsWith('worker:'))).toHaveLength(0)

			await harness.shutdown()
		})

		it('pause running worker → status paused, resume → status running', async () => {
			const { worker: deferred, started } = createDeferredWorker()

			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({ workers: [deferred] })],
				})],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'worker_deferred_start',
							input: {},
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start worker')
			await started

			const workers = selectPluginState<Map<WorkerId, WorkerEntry>>(session.state, 'workers')!
			const workerId = Array.from(workers.keys())[0]
			const entryAgentId = session.getEntryAgentId()!

			// Pause
			const pauseResult = await session.callPluginMethod('workers.pause', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				workerId: String(workerId),
			})
			expect(pauseResult.ok).toBe(true)

			let statusEvents = await session.getEventsByType(workerEvents, 'worker_status_changed')
			expect(statusEvents.some((e) => e.toStatus === 'paused')).toBe(true)

			// Resume
			const resumeResult = await session.callPluginMethod('workers.resume', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				workerId: String(workerId),
			})
			expect(resumeResult.ok).toBe(true)

			statusEvents = await session.getEventsByType(workerEvents, 'worker_status_changed')
			const resumed = statusEvents.find((e) => e.fromStatus === 'paused' && e.toStatus === 'running')
			expect(resumed).toBeDefined()

			await harness.shutdown()
		})

		it('parks a paused worker so the idle runtime evicts, and does not relaunch it', async () => {
			const resumable = createResumableWorker()
			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({ workers: [resumable.worker] })],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				sessionIdleTimeoutMs: 300,
			})
			try {
				const session = await harness.createSession('test')
				const agentId = session.getEntryAgentId()
				if (!agentId) throw new Error('Expected entry agent')
				const spawned = await session.callPluginMethod('workers.spawn', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerType: 'resumable',
					config: {},
				})
				expect(spawned.ok).toBe(true)
				if (!spawned.ok) throw new Error('Expected worker spawn to succeed')
				const { workerId } = z.object({ workerId: z.string() }).parse(spawned.value)
				await waitFor(() => resumable.runs.length === 1)

				const paused = await session.callPluginMethod('workers.pause', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerId,
				})
				expect(paused.ok).toBe(true)

				const runtime = harness.sessionManager.getRuntimeCacheStats().sessions.find((entry) => entry.id === session.sessionId)
				expect(Object.keys(runtime?.leaseReasons ?? {}).filter((reason) => reason.startsWith('worker:'))).toHaveLength(0)

				await waitFor(() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0, 5000)

				const reopened = await harness.openSession(session.sessionId)
				const entry = selectPluginState<Map<WorkerId, WorkerEntry>>(reopened.state, 'workers')?.get(WorkerId(workerId))
				expect(entry?.status).toBe('paused')
				expect(entry).toHaveProperty('state')
				expect(resumable.runs).toHaveLength(1)
			} finally {
				await harness.shutdown()
			}
		})

		it('resume launches a worker that is no longer running', async () => {
			const resumable = createResumableWorker()
			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({ workers: [resumable.worker] })],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			try {
				const session = await harness.createSession('test')
				const agentId = session.getEntryAgentId()
				if (!agentId) throw new Error('Expected entry agent')
				const spawned = await session.callPluginMethod('workers.spawn', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerType: 'resumable',
					config: {},
				})
				expect(spawned.ok).toBe(true)
				if (!spawned.ok) throw new Error('Expected worker spawn to succeed')
				const { workerId } = z.object({ workerId: z.string() }).parse(spawned.value)
				await waitFor(() => resumable.runs.length === 1)
				expect(resumable.runs[0]).toEqual({ resumed: false, ticks: 0 })

				const paused = await session.callPluginMethod('workers.pause', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerId,
				})
				expect(paused.ok).toBe(true)

				// Nothing runs a paused worker, so a command has to say so rather than start one.
				const command = await session.callPluginMethod('workers.sendCommand', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerId,
					command: 'ping',
				})
				expect(command.ok).toBe(false)
				if (!command.ok) expect(command.error.message).toContain('paused')
				expect(resumable.runs).toHaveLength(1)

				const resumed = await session.callPluginMethod('workers.resume', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerId,
				})
				expect(resumed.ok).toBe(true)

				await waitFor(() => resumable.runs.length === 2)
				// Re-entered from the top, with the state replayed from the event log.
				expect(resumable.runs[1]).toEqual({ resumed: true, ticks: 1 })

				const statusEvents = await session.getEventsByType(workerEvents, 'worker_status_changed')
				expect(statusEvents.map((event) => event.toStatus)).toEqual(['paused', 'running'])
			} finally {
				await harness.shutdown()
			}
		})

		it('two concurrent resumes launch exactly one run and take exactly one lease', async () => {
			const resumable = createResumableWorker()
			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({ workers: [resumable.worker] })],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			try {
				const session = await harness.createSession('test')
				const agentId = session.getEntryAgentId()
				if (!agentId) throw new Error('Expected entry agent')
				const spawned = await session.callPluginMethod('workers.spawn', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerType: 'resumable',
					config: {},
				})
				expect(spawned.ok).toBe(true)
				if (!spawned.ok) throw new Error('Expected worker spawn to succeed')
				const { workerId } = z.object({ workerId: z.string() }).parse(spawned.value)
				await waitFor(() => resumable.runs.length === 1)

				const paused = await session.callPluginMethod('workers.pause', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerId,
				})
				expect(paused.ok).toBe(true)

				// Both handlers run before either emit lands, so the guard has to claim the
				// slot synchronously — a second launch would overwrite the entry and orphan
				// the first run, whose lease nothing can then release.
				const [first, second] = await Promise.all([
					session.callPluginMethod('workers.resume', {
						sessionId: String(session.sessionId),
						agentId: String(agentId),
						workerId,
					}),
					session.callPluginMethod('workers.resume', {
						sessionId: String(session.sessionId),
						agentId: String(agentId),
						workerId,
					}),
				])
				expect([first.ok, second.ok].filter((ok) => ok)).toHaveLength(1)

				await waitFor(() => resumable.runs.length >= 2)
				await new Promise((resolve) => setTimeout(resolve, 100))
				expect(resumable.runs).toHaveLength(2)

				const runtime = harness.sessionManager.getRuntimeCacheStats().sessions.find((entry) => entry.id === session.sessionId)
				expect(runtime?.leaseReasons[`worker:${workerId}`]).toBe(1)

				const statusEvents = await session.getEventsByType(workerEvents, 'worker_status_changed')
				expect(statusEvents.map((event) => event.toStatus)).toEqual(['paused', 'running'])
			} finally {
				await harness.shutdown()
			}
		})

		it('refuses to cancel a completed worker still draining its effects', async () => {
			const terminal = createTerminalThenEffectsWorker()
			const eventStore = new ArmedGateEventStore()
			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({
						workers: [terminal.worker],
						// The drain has to outlast the cancel below — that is what keeps the
						// completed worker in the running map, where cancel used to find it.
						stopTimeoutMs: 50,
						effectDrainTimeoutMs: 2000,
					})],
				})],
				eventStore,
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			try {
				const session = await harness.createSession('test')
				const agentId = session.getEntryAgentId()
				if (!agentId) throw new Error('Expected entry agent')
				const effectParked = eventStore.arm(['worker_sub_event'])
				const spawned = await session.callPluginMethod('workers.spawn', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerType: 'terminal-then-effects',
					config: {},
				})
				expect(spawned.ok).toBe(true)
				if (!spawned.ok) throw new Error('Expected worker spawn to succeed')
				const { workerId } = z.object({ workerId: z.string() }).parse(spawned.value)
				await terminal.started
				await effectParked
				await waitFor(() => (
					selectPluginState<Map<WorkerId, WorkerEntry>>(session.state, 'workers')?.get(WorkerId(workerId))?.status === 'completed'
				))

				const cancelled = await session.callPluginMethod('workers.cancel', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerId,
				})
				expect(cancelled.ok).toBe(false)
				if (!cancelled.ok) expect(cancelled.error.message).toContain('completed')

				const entry = selectPluginState<Map<WorkerId, WorkerEntry>>(session.state, 'workers')?.get(WorkerId(workerId))
				expect(entry?.status).toBe('completed')
				expect(entry?.result?.summary).toBe('REAL RESULT')
				expect(await session.getEventsByType(workerEvents, 'worker_status_changed')).toHaveLength(0)
			} finally {
				eventStore.release()
				await harness.shutdown()
			}
		})

		it('parks a paused worker again when its resume cannot launch, keeping it resumable', async () => {
			const resumable = createResumableWorker()
			const eventStore = new ArmedGateEventStore()
			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({ workers: [resumable.worker] })],
				})],
				eventStore,
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			try {
				const session = await harness.createSession('test')
				const agentId = session.getEntryAgentId()
				if (!agentId) throw new Error('Expected entry agent')
				const spawn = async (): Promise<string> => {
					const spawned = await session.callPluginMethod('workers.spawn', {
						sessionId: String(session.sessionId),
						agentId: String(agentId),
						workerType: 'resumable',
						config: {},
					})
					expect(spawned.ok).toBe(true)
					if (!spawned.ok) throw new Error('Expected worker spawn to succeed')
					return z.object({ workerId: z.string() }).parse(spawned.value).workerId
				}

				for (let i = 0; i < MAX_CONCURRENT_WORKERS - 1; i++) await spawn()
				const workerId = await spawn()
				await waitFor(() => resumable.runs.length === MAX_CONCURRENT_WORKERS)

				const paused = await session.callPluginMethod('workers.pause', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerId,
				})
				expect(paused.ok).toBe(true)

				// Take the last slot while the resume is parked mid-emit, so its launch refuses.
				const statusParked = eventStore.arm(['worker_status_changed'])
				const resumePromise = session.callPluginMethod('workers.resume', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerId,
				})
				await statusParked
				await spawn()
				eventStore.release()

				const resumed = await resumePromise
				expect(resumed.ok).toBe(false)
				if (!resumed.ok) expect(resumed.error.message).toContain('Max concurrent workers reached')

				const entry = selectPluginState<Map<WorkerId, WorkerEntry>>(session.state, 'workers')?.get(WorkerId(workerId))
				expect(entry?.status).toBe('paused')
				expect(entry).toHaveProperty('config')
				expect(z.object({ ticks: z.number() }).parse(entry?.state)).toEqual({ ticks: 1 })
			} finally {
				eventStore.release()
				await harness.shutdown()
			}
		})

		it('refuses to resume a worker whose stop timed out, until its body finally returns', async () => {
			const unstoppable = createUnstoppableWorker()
			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({
						workers: [unstoppable.worker],
						stopTimeoutMs: 50,
						effectDrainTimeoutMs: 50,
					})],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			try {
				const session = await harness.createSession('test')
				const agentId = session.getEntryAgentId()
				if (!agentId) throw new Error('Expected entry agent')
				const spawned = await session.callPluginMethod('workers.spawn', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerType: 'unstoppable',
					config: {},
				})
				expect(spawned.ok).toBe(true)
				if (!spawned.ok) throw new Error('Expected worker spawn to succeed')
				const { workerId } = z.object({ workerId: z.string() }).parse(spawned.value)
				await unstoppable.started

				// The body outlives the stop bound, so pause drops the entry while it runs on.
				const paused = await session.callPluginMethod('workers.pause', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerId,
				})
				expect(paused.ok).toBe(true)

				const resume = async () => session.callPluginMethod('workers.resume', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerId,
				})
				const refused = await resume()
				expect(refused.ok).toBe(false)
				if (!refused.ok) expect(refused.error.message).toContain('did not stop within its deadline')
				expect(unstoppable.runs).toHaveLength(1)

				// Once the abandoned body returns, the worker is launchable again.
				unstoppable.release()
				let relaunched = await resume()
				const deadline = Date.now() + 2000
				while (!relaunched.ok && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 10))
					relaunched = await resume()
				}
				expect(relaunched.ok).toBe(true)
				expect(unstoppable.runs).toEqual([false, true])
			} finally {
				unstoppable.release()
				await harness.shutdown()
			}
		})

		it('pause non-running worker → error', async () => {
			const harness = createWorkersHarness({
				presets: [createWorkersPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'worker_immediate_start',
							input: { value: 'x' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start worker')
			await new Promise((r) => setTimeout(r, 100))

			// Worker already completed - pause should fail
			const workers = selectPluginState<Map<WorkerId, WorkerEntry>>(session.state, 'workers')!
			const workerId = Array.from(workers.keys())[0]
			const entryAgentId = session.getEntryAgentId()!

			const result = await session.callPluginMethod('workers.pause', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				workerId: String(workerId),
			})
			expect(result.ok).toBe(false)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Worker commands
	// =========================================================================

	describe('worker commands', () => {
		it('worker with commands → generates command tool', async () => {
			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({ workers: [commandWorker] })],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const lastRequest = harness.llmProvider.getLastRequest()
			const toolNames = lastRequest?.tools?.map((t) => t.name) ?? []
			expect(toolNames).toContain('worker_commandable_start')
			expect(toolNames).toContain('worker_commandable_update_config')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Concurrent worker limit
	// =========================================================================

	describe('concurrent worker limit', () => {
		it('spawning more than 10 workers → 11th fails with max reached', async () => {
			// Create 11 deferred workers with different types
			const deferredWorkers = Array.from({ length: 11 }, (_, i) => {
				const { worker } = createDeferredWorker()
				return createWorkerDefinition(
					`deferred_${i}`,
					`Deferred worker ${i}`,
					z.object({}),
					{
						initialState: () => ({}),
						reduce: (state: {}) => state,
						execute: async (_config, ctx) => {
							while (ctx.shouldContinue()) {
								await new Promise((r) => setTimeout(r, 10))
							}
							return Ok({ status: 'done', summary: 'Done' })
						},
					},
				)
			})

			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({ workers: deferredWorkers })],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const entryAgentId = session.getEntryAgentId()!

			// Spawn 10 workers
			for (let i = 0; i < 10; i++) {
				const result = await session.callPluginMethod('workers.spawn', {
					sessionId: String(session.sessionId),
					agentId: String(entryAgentId),
					workerType: `deferred_${i}`,
					config: {},
				})
				expect(result.ok).toBe(true)
			}

			// 11th should fail
			const result = await session.callPluginMethod('workers.spawn', {
				sessionId: String(session.sessionId),
				agentId: String(entryAgentId),
				workerType: 'deferred_10',
				config: {},
			})
			expect(result.ok).toBe(false)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Session close cleanup
	// =========================================================================

	describe('session close cleanup', () => {
		it('closing session cancels running workers', async () => {
			const { worker: deferred, started } = createDeferredWorker()

			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({ workers: [deferred] })],
				})],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'worker_deferred_start',
							input: {},
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start worker')
			await started

			// Verify worker is running
			const workers = selectPluginState<Map<WorkerId, WorkerEntry>>(session.state, 'workers')!
			expect(workers.size).toBe(1)
			const worker = Array.from(workers.values())[0]
			expect(worker.status).toBe('running')

			// Close session → should cancel workers
			await session.close()
			await new Promise((r) => setTimeout(r, 200))

			await harness.shutdown()
		})

		it('waits for in-flight emit, notify, and terminal effects after worker close timeout', async () => {
			const inFlight = createInFlightEffectsWorker()
			const eventStore = new GatedWorkerEffectEventStore()
			const llmProvider = MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] })
			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({
						workers: [inFlight.worker, immediateWorker],
						// Short execution bound, long drain bound: close must give up on the
						// worker body but still wait for the effects it left in flight.
						stopTimeoutMs: 50,
						effectDrainTimeoutMs: 10 * WORKER_STOP_TIMEOUT_MS,
					})],
				})],
				eventStore,
				llmProvider,
			})
			const session = await harness.createSession('test')
			const agentId = session.getEntryAgentId()
			if (!agentId) throw new Error('Expected entry agent')
			const spawned = await session.callPluginMethod('workers.spawn', {
				sessionId: String(session.sessionId),
				agentId: String(agentId),
				workerType: 'in-flight-effects',
				config: {},
			})
			expect(spawned.ok).toBe(true)
			if (!spawned.ok) throw new Error('Expected worker spawn to succeed')
			const { workerId } = z.object({ workerId: z.string() }).parse(spawned.value)
			await inFlight.started
			const terminalSpawned = await session.callPluginMethod('workers.spawn', {
				sessionId: String(session.sessionId),
				agentId: String(agentId),
				workerType: 'immediate',
				config: { value: 'terminal-gate' },
			})
			expect(terminalSpawned.ok).toBe(true)
			if (!terminalSpawned.ok) throw new Error('Expected terminal worker spawn to succeed')
			const { workerId: terminalWorkerId } = z.object({ workerId: z.string() }).parse(terminalSpawned.value)
			await eventStore.effectsStarted

			let closeFinished = false
			const closePromise = session.close().then(() => {
				closeFinished = true
			})
			await new Promise((resolve) => setTimeout(resolve, 250))
			expect(closeFinished).toBe(false)
			const runtime = harness.sessionManager.getRuntimeCacheStats().sessions.find((entry) => entry.id === session.sessionId)
			expect(runtime?.leaseReasons[`worker:${workerId}:effect`]).toBe(2)
			expect(runtime?.leaseReasons[`worker:${terminalWorkerId}:effect`]).toBe(1)

			eventStore.release()
			await closePromise
			expect(eventStore.hasCompleted('worker_sub_event')).toBe(true)
			expect(eventStore.hasCompleted('mailbox_message')).toBe(true)
			expect(eventStore.hasCompleted('worker_completed')).toBe(true)
			expect(llmProvider.getCallCount()).toBe(0)
			const eventsAfterClose = await session.getEvents()
			inFlight.finishBody()
			await new Promise((resolve) => setTimeout(resolve, 20))

			expect(await session.getEvents()).toEqual(eventsAfterClose)
			expect(await session.getEventsByType(workerEvents, 'worker_sub_event')).toHaveLength(1)
			expect(await session.getEventsByType(mailboxEvents, 'mailbox_message')).toHaveLength(1)
			expect(await session.getEventsByType(workerEvents, 'worker_completed')).toHaveLength(1)
			expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
			await harness.shutdown()
		})

		it('bounds the effect drain so a stalled event store cannot hang close', async () => {
			const inFlight = createInFlightEffectsWorker()
			const eventStore = new GatedWorkerEffectEventStore()
			const harness = createWorkersHarness({
				presets: [createTestPreset({
					plugins: [workerPlugin.configure({
						workers: [inFlight.worker, immediateWorker],
						stopTimeoutMs: 50,
						effectDrainTimeoutMs: 50,
					})],
				})],
				eventStore,
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})
			try {
				const session = await harness.createSession('test')
				const agentId = session.getEntryAgentId()
				if (!agentId) throw new Error('Expected entry agent')
				const spawned = await session.callPluginMethod('workers.spawn', {
					sessionId: String(session.sessionId),
					agentId: String(agentId),
					workerType: 'in-flight-effects',
					config: {},
				})
				expect(spawned.ok).toBe(true)
				await inFlight.started

				// The event store never releases: close must still return on its own bound.
				await session.close()
				expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
			} finally {
				eventStore.release()
				inFlight.finishBody()
				await harness.shutdown()
			}
		})
	})

	// =========================================================================
	// Worker artifacts
	// =========================================================================

	describe('worker file writing', () => {
		it('worker writes file via files store → worker completes successfully', async () => {
			const harness = createWorkersHarness({
				presets: [createWorkersPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'worker_artifact_start',
							input: {},
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start worker')
			await new Promise((r) => setTimeout(r, 200))

			const completedEvents = await session.getEventsByType(workerEvents, 'worker_completed')
			expect(completedEvents).toHaveLength(1)
			expect(completedEvents[0].result.summary).toBe('Wrote file')

			const workers = selectPluginState<Map<WorkerId, WorkerEntry>>(session.state, 'workers')!
			const worker = Array.from(workers.values())[0]
			expect(worker.status).toBe('completed')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Worker agent notification
	// =========================================================================

	describe('worker agent notification', () => {
		it('worker calls notifyAgent → mailbox message emitted', async () => {
			const harness = createWorkersHarness({
				presets: [createWorkersPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'worker_notifying_start',
							input: {},
						}],
					},
					// Agent may be re-scheduled due to mailbox message
					{ content: 'Got it', toolCalls: [] },
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start worker', { timeoutMs: 5000 })
			await new Promise((r) => setTimeout(r, 200))

			// Check for mailbox_message event with worker's notification
			const mailboxMessages = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			const workerMessage = mailboxMessages.find((event) => event.message.content === 'Progress update: 50%')
			if (workerMessage === undefined || workerMessage.sequence === undefined) {
				throw new Error('Expected worker mailbox message with a sequence')
			}
			expect(workerMessage.sequence).toBeGreaterThan(0)
			expect(workerMessage.message.id).toBe(generateMessageId(workerMessage.sequence))

			await harness.shutdown()
		})
	})
})
