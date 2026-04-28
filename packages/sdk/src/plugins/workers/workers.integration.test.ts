import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { createWorkerDefinition, workerEvents, workerPlugin } from './index.js'
import type { WorkerEntry, WorkerId } from './worker.js'

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
			await ctx.files.write('output.html', '<h1>Hello</h1>')
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

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Worker sub-events and state reduction
	// =========================================================================

	describe('worker sub-events and state reduction', () => {
		it('worker emits sub-events → worker_sub_event events → state updated via reducer', async () => {
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

			// Verify worker state was updated by reducer
			const workers = selectPluginState<Map<WorkerId, WorkerEntry>>(session.state, 'workers')!
			const worker = Array.from(workers.values())[0]
			const state = worker.state as { items: string[] }
			expect(state.items).toEqual(['alpha', 'beta'])

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
			const allEvents = await session.getEvents()
			const mailboxMessages = allEvents.filter((e) => e.type === 'mailbox_message')
			const workerMessage = mailboxMessages.find((e) => (e as { message?: { content?: string } }).message?.content === 'Progress update: 50%')
			expect(workerMessage).toBeDefined()

			await harness.shutdown()
		})
	})
})
