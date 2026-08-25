import z from 'zod/v4'
import { type AgentId, agentIdSchema } from '~/core/agents/schema.js'
import { ValidationErrors } from '~/core/errors.js'
import type { FileStore } from '~/core/file-store/types.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import type { SessionRuntimeActivity } from '~/core/sessions/runtime-activity.js'
import type { SessionId } from '~/core/sessions/schema.js'
import type { SessionState } from '~/core/sessions/state.js'
import { createTool, type ToolDefinition } from '~/core/tools/definition.js'
import { Err, Ok, type Result } from '~/lib/utils/result.js'
import type { Logger } from '../../lib/logger/logger.js'
import { WorkerContextImpl } from './context.js'
import { workerEvents } from './state.js'
import type { EmitEvent } from './state.js'
import type { WorkerCommandDefinition, WorkerDefinition, WorkerSubEvent } from './definition.js'
import { generateWorkerId, type WorkerEntry, WorkerId, type WorkerId as WorkerIdType, workerIdSchema } from './worker.js'


/** Most workers a single session runtime runs at once. */
export const MAX_CONCURRENT_WORKERS = 10

/** Default bound on waiting for a stopped worker's `execute()` to return. */
export const WORKER_STOP_TIMEOUT_MS = 5000

/** Default bound on draining the context effects a stopped worker left in flight. */
export const WORKER_EFFECT_DRAIN_TIMEOUT_MS = 5000

/**
 * Session-wide worker configuration.
 */
export interface WorkerPresetConfig {
	/** Available worker definitions */
	workers: WorkerDefinition[]
	/** Bound on waiting for `execute()` to return when stopping. Defaults to WORKER_STOP_TIMEOUT_MS. */
	stopTimeoutMs?: number
	/** Bound on draining in-flight context effects after a stop. Defaults to WORKER_EFFECT_DRAIN_TIMEOUT_MS. */
	effectDrainTimeoutMs?: number
}

/**
 * Agent-specific worker configuration.
 */
export interface WorkerAgentConfig {
	/** Worker types this agent can spawn (empty = all) */
	workers?: string[]
}

// ============================================================================
// Types moved from executor.ts
// ============================================================================


/**
 * Represents a running worker instance.
 */
interface RunningWorker {
	workerId: WorkerId
	workerType: string
	definition: WorkerDefinition
	context: WorkerContextImpl<unknown, WorkerSubEvent>
	promise: Promise<void>
	releaseLease: () => void
	executionControl: WorkerExecutionControl
}

interface WorkerExecutionControl {
	suppressTerminalEvent: boolean
}

// ============================================================================
// Worker execution helper
// ============================================================================

async function executeWorker(
	workerId: WorkerId,
	definition: WorkerDefinition,
	config: unknown,
	context: WorkerContextImpl<unknown, WorkerSubEvent>,
	runningWorkers: Map<WorkerIdType, RunningWorker>,
	logger: Logger,
	releaseLease: () => void,
	executionControl: WorkerExecutionControl,
	effectDrainTimeoutMs: number,
): Promise<void> {
	try {
		const result = await definition.execute(config, context)
		if (executionControl.suppressTerminalEvent) return

		if (result.ok) {
			const persisted = await context.persistTerminal(workerEvents.create('worker_completed', {
				workerId,
				result: result.value,
			}))
			if (persisted) logger.info('Worker completed', { workerId, result: result.value.summary })
		} else {
			const persisted = await context.persistTerminal(workerEvents.create('worker_failed', {
				workerId,
				error: result.error.message,
				resumable: result.error.resumable,
			}))
			if (persisted) logger.warn('Worker failed', { workerId, error: result.error.message, resumable: result.error.resumable })
		}
	} catch (error) {
		if (executionControl.suppressTerminalEvent) return
		const message = error instanceof Error ? error.message : String(error)
		const persisted = await context.persistTerminal(workerEvents.create('worker_failed', {
			workerId,
			error: message,
			resumable: false,
		}))
		if (persisted) logger.error('Worker threw exception', error instanceof Error ? error : undefined, { workerId })
	} finally {
		// Bounded like the stop path: a stalled append must not hold the runtime lease forever.
		const drained = await awaitWithin(context.waitForEffects(), effectDrainTimeoutMs)
		if (!drained) context.releaseEffectLeases()
		// A stop may already have replaced this entry with a relaunch; only drop our own.
		if (runningWorkers.get(workerId)?.context === context) runningWorkers.delete(workerId)
		releaseLease()
	}
}

// ============================================================================
// Bounded worker stop
// ============================================================================

interface StopTimeouts {
	stopTimeoutMs: number
	effectDrainTimeoutMs: number
}

function resolveStopTimeouts(pluginConfig: WorkerPresetConfig): StopTimeouts {
	return {
		stopTimeoutMs: pluginConfig.stopTimeoutMs ?? WORKER_STOP_TIMEOUT_MS,
		effectDrainTimeoutMs: pluginConfig.effectDrainTimeoutMs ?? WORKER_EFFECT_DRAIN_TIMEOUT_MS,
	}
}

/** Await `work`, giving up after `timeoutMs`. Returns false when the wait timed out. */
async function awaitWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<boolean>((resolve) => {
		timeoutId = setTimeout(() => resolve(false), timeoutMs)
	})
	try {
		return await Promise.race([work.then(() => true, () => true), timeout])
	} finally {
		if (timeoutId) clearTimeout(timeoutId)
	}
}

/**
 * Stop workers and give back their runtime leases, on a deadline.
 *
 * Shared by cancel, pause and session close so the three cannot drift: a worker
 * that ignores cancellation must never pin the runtime, so both the execution
 * wait and the effect drain are bounded and the leases are force-released once
 * either bound expires.
 *
 * Giving up on the body does not stop it. A worker whose `execute()` outlived
 * `stopTimeoutMs` keeps running with a live FileStore after its map entry is
 * gone, so it is recorded in `abandonedWorkers` and `resume` refuses to launch a
 * second body beside it until the first one finally returns.
 */
async function stopWorkers(
	workers: readonly RunningWorker[],
	runningWorkers: Map<WorkerIdType, RunningWorker>,
	abandonedWorkers: Set<WorkerIdType>,
	timeouts: StopTimeouts,
): Promise<void> {
	if (workers.length === 0) return

	for (const worker of workers) {
		worker.executionControl.suppressTerminalEvent = true
		worker.context.invalidate()
	}

	const exited = await awaitWithin(Promise.allSettled(workers.map((worker) => worker.promise)), timeouts.stopTimeoutMs)
	const drained = await awaitWithin(
		Promise.allSettled(workers.map((worker) => worker.context.waitForEffects())),
		timeouts.effectDrainTimeoutMs,
	)
	if (!exited || !drained) {
		for (const worker of workers) worker.releaseLease()
	}
	// The `worker:<id>` lease is not the only one a stalled write holds.
	if (!drained) {
		for (const worker of workers) worker.context.releaseEffectLeases()
	}
	if (!exited) {
		for (const worker of workers) {
			abandonedWorkers.add(worker.workerId)
			void worker.promise.then(() => abandonedWorkers.delete(worker.workerId))
		}
	}

	for (const worker of workers) {
		if (runningWorkers.get(worker.workerId) === worker) runningWorkers.delete(worker.workerId)
	}
}

/** Explain why a worker is not available for an operation that needs it running. */
function describeUnavailableWorker(workerId: WorkerIdType, entry: WorkerEntry | undefined): string {
	if (!entry) return `Worker not found: ${workerId}`
	if (entry.status === 'paused') return `Worker is paused: ${workerId} — resume it first`
	if (entry.status !== 'running') return `Worker is ${entry.status}: ${workerId}`
	// Projection says running but no body is resident — the relaunch has not landed yet.
	return `Worker is stopped and pending relaunch: ${workerId}`
}

interface LaunchWorkerParams {
	sessionId: SessionId
	agentId: AgentId
	workerId: WorkerId
	definition: WorkerDefinition
	config: unknown
	initialState: unknown
	/** Whether `execute()` is being re-entered for a worker that already ran. */
	resumed: boolean
	files: FileStore
	emitEvent: EmitEvent
	getSessionState: () => SessionState
	reserveMailboxMessageSequence: () => number
	scheduleAgent: (agentId: AgentId) => void
	runtimeActivity: SessionRuntimeActivity
	runningWorkers: Map<WorkerIdType, RunningWorker>
	/** Bound on draining the effects this run leaves in flight when it returns. */
	effectDrainTimeoutMs: number
	logger: Logger
}

/**
 * Start a worker in the current runtime.
 *
 * The concurrency cap lives here so the unattended relaunch at boot cannot
 * exceed what `spawn` allows.
 */
function launchWorker({
	sessionId,
	agentId,
	workerId,
	definition,
	config,
	initialState,
	resumed,
	files,
	emitEvent,
	getSessionState,
	reserveMailboxMessageSequence,
	scheduleAgent,
	runtimeActivity,
	runningWorkers,
	effectDrainTimeoutMs,
	logger,
}: LaunchWorkerParams): Result<void, string> {
	if (runningWorkers.size >= MAX_CONCURRENT_WORKERS) {
		return Err(`Max concurrent workers reached (${MAX_CONCURRENT_WORKERS})`)
	}
	const releaseLease = runtimeActivity.tryAcquire(`worker:${workerId}`)
	if (!releaseLease) return Err('Session runtime is no longer accepting workers')

	const workerLogger = logger.child({ workerId, workerType: definition.type })
	const workerContext = new WorkerContextImpl({
		sessionId,
		workerId,
		agentId,
		workerType: definition.type,
		files,
		emitEvent,
		getSessionState,
		reserveMailboxMessageSequence,
		acquireEffectLease: () => runtimeActivity.tryAcquire(`worker:${workerId}:effect`),
		reducer: definition.reduce,
		initialState,
		resumed,
		logger: workerLogger,
		schedule: () => scheduleAgent(agentId),
	})

	const executionControl: WorkerExecutionControl = { suppressTerminalEvent: false }
	const promise = executeWorker(
		workerId,
		definition,
		config,
		workerContext,
		runningWorkers,
		logger,
		releaseLease,
		executionControl,
		effectDrainTimeoutMs,
	).catch((error) => {
		logger.error('Unhandled error in worker execution', error instanceof Error ? error : undefined, {
			workerId,
		})
	})

	runningWorkers.set(workerId, {
		workerId,
		workerType: definition.type,
		definition,
		context: workerContext,
		promise,
		releaseLease,
		executionControl,
	})
	return Ok(undefined)
}

// ============================================================================
// Helper functions for creating worker tools
// ============================================================================

/**
 * Information about a worker that can be spawned.
 */
interface SpawnableWorkerInfo {
	type: string
	description: string
	configSchema: z.ZodType<unknown>
}

// ============================================================================
// Worker Plugin
// ============================================================================

export const workerPlugin = definePlugin('workers')
	.pluginConfig<WorkerPresetConfig>()
	.events([workerEvents])
	.state({
		key: 'workers',
		initial: (): Map<WorkerIdType, WorkerEntry> => new Map(),
		reduce: (workers, event, _sessionState, pluginConfig) => {
			const workerDefs = pluginConfig.workers
			switch (event.type) {
				case 'worker_started': {
					const definition = workerDefs.find((w) => w.type === event.workerType)
					const initialState = definition ? definition.initialState(event.config) : {}

					const workerEntry: WorkerEntry = {
						id: event.workerId,
						agentId: event.agentId,
						workerType: event.workerType,
						status: 'running',
						state: initialState,
						config: event.config,
						createdAt: event.timestamp,
						updatedAt: event.timestamp,
					}

					const newWorkers = new Map(workers)
					newWorkers.set(event.workerId, workerEntry)
					return newWorkers
				}

				case 'worker_sub_event': {
					const worker = workers.get(event.workerId)
					if (!worker || !Object.hasOwn(worker, 'state')) return workers

					const definition = workerDefs.find((w) => w.type === event.workerType)
					const newState = definition ? definition.reduce(worker.state, event.subEvent) : worker.state

					const newWorkers = new Map(workers)
					newWorkers.set(event.workerId, {
						...worker,
						state: newState,
						updatedAt: event.timestamp,
					})
					return newWorkers
				}

				case 'worker_status_changed': {
					const worker = workers.get(event.workerId)
					if (!worker) return workers

					const newWorkers = new Map(workers)
					if (event.toStatus === 'running' || event.toStatus === 'paused') {
						newWorkers.set(event.workerId, {
							...worker,
							status: event.toStatus,
							updatedAt: event.timestamp,
						})
					} else {
						newWorkers.set(event.workerId, {
							id: worker.id,
							agentId: worker.agentId,
							workerType: worker.workerType,
							status: event.toStatus,
							createdAt: worker.createdAt,
							updatedAt: event.timestamp,
						})
					}
					return newWorkers
				}

				case 'worker_completed': {
					const worker = workers.get(event.workerId)
					if (!worker) return workers

					const newWorkers = new Map(workers)
					newWorkers.set(event.workerId, {
						id: worker.id,
						agentId: worker.agentId,
						workerType: worker.workerType,
						status: 'completed',
						result: {
							status: event.result.status,
							resultsPath: event.result.resultsPath,
							summary: event.result.summary,
						},
						createdAt: worker.createdAt,
						updatedAt: event.timestamp,
					})
					return newWorkers
				}

				case 'worker_failed': {
					const worker = workers.get(event.workerId)
					if (!worker) return workers

					const newWorkers = new Map(workers)
					newWorkers.set(event.workerId, {
						id: worker.id,
						agentId: worker.agentId,
						workerType: worker.workerType,
						status: 'failed',
						error: { message: event.error, resumable: event.resumable },
						createdAt: worker.createdAt,
						updatedAt: event.timestamp,
					})
					return newWorkers
				}

				default:
					return workers
			}
		},
	})
	.context(async (ctx) => {
		const runningWorkers = new Map<WorkerIdType, RunningWorker>()
		// Claimed synchronously by `resume` so the emit it awaits cannot let a second
		// resume through and overwrite the live entry, leaking its lease.
		const pendingLaunches = new Set<WorkerIdType>()
		// Workers whose `execute()` outlived its stop deadline and may still be running.
		const abandonedWorkers = new Set<WorkerIdType>()
		return { runningWorkers, pendingLaunches, abandonedWorkers, logger: ctx.logger }
	})
	.agentConfig<WorkerAgentConfig>()
	.method('spawn', {
		input: z.object({
			sessionId: z.string(),
			agentId: agentIdSchema,
			workerType: z.string(),
			config: z.unknown(),
		}),
		output: z.object({
			workerId: z.string(),
		}),
		handler: async (ctx, input) => {
			const definition = ctx.pluginConfig.workers.find((w) => w.type === input.workerType)
			if (!definition) {
				return Err(ValidationErrors.invalid(`Unknown worker type: ${input.workerType}`))
			}

			// Validate config
			const validationResult = definition.configSchema.safeParse(input.config)
			if (!validationResult.success) {
				const issues = validationResult.error.issues
					.map((i) => `${i.path.join('.')}: ${i.message}`)
					.join('; ')
				return Err(ValidationErrors.invalid(`Invalid worker config: ${issues}`))
			}

			const validConfig = validationResult.data
			const workerId = generateWorkerId()
			const { runningWorkers, logger } = ctx.pluginContext
			// Refuse before persisting a start we already know we cannot honour.
			if (runningWorkers.size >= MAX_CONCURRENT_WORKERS) {
				return Err(ValidationErrors.invalid(`Max concurrent workers reached (${MAX_CONCURRENT_WORKERS})`))
			}

			// Emit worker started event
			await ctx.emitEvent(workerEvents.create('worker_started', {
				workerId,
				agentId: input.agentId,
				workerType: definition.type,
				config: validConfig,
			}))

			const sessionId = ctx.sessionId
			const agentId = input.agentId
			const files = ctx.files.session
			const emitEvent = ctx.emitEvent
			const getSessionState = ctx.getSessionState
			const reserveMailboxMessageSequence = ctx.reserveMailboxMessageSequence
			const scheduleAgent = ctx.scheduleAgent
			const runtimeActivity = ctx.runtimeActivity
			const launched = launchWorker({
				sessionId: ctx.sessionId,
				workerId,
				agentId,
				definition,
				config: validConfig,
				initialState: definition.initialState(validConfig),
				resumed: false,
				files,
				emitEvent,
				getSessionState,
				reserveMailboxMessageSequence,
				scheduleAgent,
				runtimeActivity,
				runningWorkers,
				effectDrainTimeoutMs: resolveStopTimeouts(ctx.pluginConfig).effectDrainTimeoutMs,
				logger,
			})
			if (!launched.ok) {
				// The pre-check can go stale across the emit above; keep the projection truthful.
				await ctx.emitEvent(workerEvents.create('worker_failed', {
					workerId,
					error: launched.error,
					resumable: true,
				}))
				return Err(ValidationErrors.invalid(launched.error))
			}

			logger.info('Worker started', {
				sessionId,
				workerId,
				workerType: definition.type,
				agentId: input.agentId,
			})

			return Ok({ workerId })
		},
	})
	.sessionHook('onSessionReady', async (ctx) => {
		const { runningWorkers, logger } = ctx.pluginContext
		const files = ctx.files.session
		const emitEvent = ctx.emitEvent
		const getSessionState = ctx.getSessionState
		const reserveMailboxMessageSequence = ctx.reserveMailboxMessageSequence
		const scheduleAgent = ctx.scheduleAgent
		const runtimeActivity = ctx.runtimeActivity
		const { effectDrainTimeoutMs } = resolveStopTimeouts(ctx.pluginConfig)
		// A relaunch that does not happen must not leave the projection claiming `running`
		// — park the worker instead, which keeps its state and lets `resume` pick it up.
		const parkStoppedWorker = async (workerId: WorkerIdType): Promise<void> => {
			await ctx.emitEvent(workerEvents.create('worker_status_changed', {
				workerId,
				fromStatus: 'running',
				toStatus: 'paused',
			}))
		}
		for (const worker of ctx.pluginState.values()) {
			// Paused workers stay stopped — `workers.resume` relaunches them on demand.
			if (worker.status !== 'running') continue
			if (!Object.hasOwn(worker, 'config') || !Object.hasOwn(worker, 'state')) continue
			if (runningWorkers.has(worker.id)) continue
			const definition = ctx.pluginConfig.workers.find((candidate) => candidate.type === worker.workerType)
			if (!definition) {
				logger.warn('Cannot resume worker with missing definition', { workerId: worker.id, workerType: worker.workerType })
				await parkStoppedWorker(worker.id)
				continue
			}
			const launched = launchWorker({
				sessionId: ctx.sessionId,
				agentId: worker.agentId,
				workerId: worker.id,
				definition,
				config: worker.config,
				initialState: worker.state,
				resumed: true,
				files,
				emitEvent,
				getSessionState,
				reserveMailboxMessageSequence,
				scheduleAgent,
				runtimeActivity,
				runningWorkers,
				effectDrainTimeoutMs,
				logger,
			})
			if (!launched.ok) {
				logger.warn('Cannot relaunch worker', { workerId: worker.id, workerType: worker.workerType, reason: launched.error })
				await parkStoppedWorker(worker.id)
			}
		}
	})
	.method('getStatus', {
		input: z.object({
			sessionId: z.string(),
			agentId: agentIdSchema,
			workerId: workerIdSchema,
		}),
		output: z.object({
			status: z.string(),
			state: z.unknown().optional(),
		}),
		handler: async (ctx, input) => {
			const worker = ctx.pluginState.get(WorkerId(input.workerId))
			if (!worker) {
				return Err(ValidationErrors.invalid(`Worker not found: ${input.workerId}`))
			}

			let state: unknown
			if (worker.status === 'running' || worker.status === 'paused') {
				const definition = ctx.pluginConfig.workers.find((w) => w.type === worker.workerType)
				state = definition?.summarizeState ? definition.summarizeState(worker.state) : worker.state
			} else {
				state = worker.result ?? worker.error
			}

			return Ok({
				status: worker.status,
				state,
			})
		},
	})
	.method('sendCommand', {
		input: z.object({
			sessionId: z.string(),
			agentId: agentIdSchema,
			workerId: workerIdSchema,
			command: z.string(),
			data: z.unknown().optional(),
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const workerId = WorkerId(input.workerId)
			const worker = ctx.pluginContext.runningWorkers.get(workerId)
			if (!worker) {
				// Commands run against a live context, and starting one here would silently
				// undo an explicit pause — the caller resumes first.
				return Err(ValidationErrors.invalid(describeUnavailableWorker(workerId, ctx.pluginState.get(workerId))))
			}

			if (!worker.definition.handleCommand) {
				return Err(ValidationErrors.invalid(`Worker type ${worker.workerType} does not support commands`))
			}

			const result = await worker.definition.handleCommand(
				{ command: input.command, data: input.data },
				worker.context,
			)
			if (!result.ok) return Err(ValidationErrors.invalid(result.error.message))
			return Ok({})
		},
	})
	.method('cancel', {
		input: z.object({
			sessionId: z.string(),
			agentId: agentIdSchema,
			workerId: workerIdSchema,
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const workerId = WorkerId(input.workerId)
			const { runningWorkers, abandonedWorkers } = ctx.pluginContext
			const worker = runningWorkers.get(workerId)
			const workerEntry = ctx.pluginState.get(workerId)
			// The projection decides, not the map: a completed worker lingers there for the
			// whole of its effect drain, and cancelling it would overwrite its real result.
			if (!workerEntry || (workerEntry.status !== 'running' && workerEntry.status !== 'paused')) {
				return Err(ValidationErrors.invalid(describeUnavailableWorker(workerId, workerEntry)))
			}

			// Bounded, so a worker that ignores cancellation cannot hold the runtime open.
			if (worker) await stopWorkers([worker], runningWorkers, abandonedWorkers, resolveStopTimeouts(ctx.pluginConfig))

			await ctx.emitEvent(workerEvents.create('worker_status_changed', {
				workerId,
				fromStatus: workerEntry.status,
				toStatus: 'cancelled',
			}))

			return Ok({})
		},
	})
	.method('pause', {
		input: z.object({
			sessionId: z.string(),
			agentId: agentIdSchema,
			workerId: workerIdSchema,
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const workerId = WorkerId(input.workerId)
			const { runningWorkers, abandonedWorkers } = ctx.pluginContext
			const worker = runningWorkers.get(workerId)
			if (!worker) {
				return Err(ValidationErrors.invalid(describeUnavailableWorker(workerId, ctx.pluginState.get(workerId))))
			}

			const workerEntry = ctx.pluginState.get(workerId)
			const fromStatus = workerEntry?.status ?? 'running'

			if (fromStatus !== 'running') {
				return Err(ValidationErrors.invalid(`Worker not in running state: ${fromStatus}`))
			}

			// Pausing stops the run instead of spinning it: a parked worker must not keep
			// the runtime resident. `resume` re-enters execute() with the replayed state.
			worker.context.pause()
			await stopWorkers([worker], runningWorkers, abandonedWorkers, resolveStopTimeouts(ctx.pluginConfig))

			await ctx.emitEvent(workerEvents.create('worker_status_changed', {
				workerId,
				fromStatus,
				toStatus: 'paused',
			}))

			return Ok({})
		},
	})
	.method('resume', {
		input: z.object({
			sessionId: z.string(),
			agentId: agentIdSchema,
			workerId: workerIdSchema,
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const workerId = WorkerId(input.workerId)
			const { runningWorkers, pendingLaunches, abandonedWorkers, logger } = ctx.pluginContext
			const workerEntry = ctx.pluginState.get(workerId)
			if (!workerEntry) {
				return Err(ValidationErrors.invalid(`Worker not found: ${input.workerId}`))
			}
			if (workerEntry.status !== 'paused') {
				return Err(ValidationErrors.invalid(`Worker not in paused state: ${workerEntry.status}`))
			}
			if (!Object.hasOwn(workerEntry, 'config') || !Object.hasOwn(workerEntry, 'state')) {
				return Err(ValidationErrors.invalid(`Worker is no longer resumable: ${input.workerId}`))
			}
			const definition = ctx.pluginConfig.workers.find((candidate) => candidate.type === workerEntry.workerType)
			if (!definition) {
				return Err(ValidationErrors.invalid(`Unknown worker type: ${workerEntry.workerType}`))
			}
			// Nothing runs a paused worker any more, so resume relaunches it — and must
			// never overwrite a live entry, whose lease would then leak. The claim below
			// is therefore taken in the same synchronous block as the checks: everything
			// from here to `pendingLaunches.add` must stay free of `await`.
			if (runningWorkers.has(workerId)) {
				return Err(ValidationErrors.invalid(`Worker is already running: ${input.workerId}`))
			}
			if (pendingLaunches.has(workerId)) {
				return Err(ValidationErrors.invalid(`Worker is already resuming: ${input.workerId}`))
			}
			if (abandonedWorkers.has(workerId)) {
				return Err(ValidationErrors.invalid(
					`Worker did not stop within its deadline and may still be running: ${input.workerId}`,
				))
			}
			if (runningWorkers.size + pendingLaunches.size >= MAX_CONCURRENT_WORKERS) {
				return Err(ValidationErrors.invalid(`Max concurrent workers reached (${MAX_CONCURRENT_WORKERS})`))
			}
			pendingLaunches.add(workerId)

			try {
				// The status event goes first: a worker that finishes instantly would otherwise
				// have its terminal projection overwritten by this event.
				await ctx.emitEvent(workerEvents.create('worker_status_changed', {
					workerId,
					fromStatus: 'paused',
					toStatus: 'running',
				}))

				const launched = launchWorker({
					sessionId: ctx.sessionId,
					agentId: workerEntry.agentId,
					workerId,
					definition,
					config: workerEntry.config,
					initialState: workerEntry.state,
					resumed: true,
					files: ctx.files.session,
					emitEvent: ctx.emitEvent,
					getSessionState: ctx.getSessionState,
					reserveMailboxMessageSequence: ctx.reserveMailboxMessageSequence,
					scheduleAgent: ctx.scheduleAgent,
					runtimeActivity: ctx.runtimeActivity,
					runningWorkers,
					effectDrainTimeoutMs: resolveStopTimeouts(ctx.pluginConfig).effectDrainTimeoutMs,
					logger,
				})
				if (!launched.ok) {
					// Park it again rather than fail it: both triggers are transient, and a
					// `worker_failed` would drop the state and config that keep it resumable.
					await ctx.emitEvent(workerEvents.create('worker_status_changed', {
						workerId,
						fromStatus: 'running',
						toStatus: 'paused',
						reason: launched.error,
					}))
					return Err(ValidationErrors.invalid(launched.error))
				}

				return Ok({})
			} finally {
				pendingLaunches.delete(workerId)
			}
		},
	})
	.sessionHook('onSessionClose', async (ctx) => {
		const { runningWorkers, abandonedWorkers, logger } = ctx.pluginContext
		if (runningWorkers.size === 0) return
		const closingWorkers = [...runningWorkers.values()]

		logger.info('Cancelling running workers on session close', { count: closingWorkers.length })

		await stopWorkers(closingWorkers, runningWorkers, abandonedWorkers, resolveStopTimeouts(ctx.pluginConfig))

		runningWorkers.clear()
	})
	.tools((ctx) => {
		const workerMap = new Map(ctx.pluginConfig.workers.map((w) => [w.type, w]))
		const visibleWorkerTypes = ctx.pluginAgentConfig?.workers ?? Array.from(workerMap.keys())
		const visibleWorkers = visibleWorkerTypes.filter((t) => workerMap.has(t))

		if (visibleWorkers.length === 0) return []

		const tools: ToolDefinition<any>[] = []

		/**
		 * Creates a worker_<type>_start tool with typed config schema.
		 */
		function createWorkerStartTool(worker: SpawnableWorkerInfo): ToolDefinition {
			const toolName = `worker_${worker.type}_start`
			const description = `Start a ${worker.type} worker. ${worker.description} (async, in response will ONLY confirm spawning)`

			return createTool({
				name: toolName,
				description,
				input: worker.configSchema,
				execute: async (config, context) => {
					const result = await ctx.self.spawn({
						sessionId: ctx.sessionState.id,
						agentId: context.agentId,
						workerType: worker.type,
						config,
					})

					if (!result.ok) {
						return Err({ message: result.error.message, recoverable: false })
					}
					return Ok(JSON.stringify({ workerId: result.value.workerId, status: 'started' }))
				},
			})
		}

		/**
		 * Creates a worker_<type>_<command> tool for a specific worker command.
		 */
		function createWorkerCommandTool(
			workerType: string,
			commandName: string,
			commandDef: WorkerCommandDefinition,
		): ToolDefinition<any> {
			const toolName = `worker_${workerType}_${commandName}`

			const commandSchema = z.object({
				workerId: workerIdSchema,
				input: commandDef.schema,
			})

			return createTool({
				name: toolName,
				description: commandDef.description,
				input: commandSchema,
				execute: async (input, context) => {
					const { workerId, input: args } = input
					const result = await ctx.self.sendCommand({
						sessionId: ctx.sessionState.id,
						agentId: context.agentId,
						workerId,
						command: commandName,
						data: args,
					})

					if (!result.ok) return Err({ message: result.error.message, recoverable: false })
					return Ok(JSON.stringify({ status: 'command_sent', command: commandName }))
				},
			})
		}

		// Generate worker_<type>_start tools for each visible worker
		for (const workerType of visibleWorkers) {
			const definition = workerMap.get(workerType)!
			tools.push(createWorkerStartTool({
				type: definition.type,
				description: definition.description,
				configSchema: definition.configSchema,
			}))

			// Generate command tools if worker has commands
			if (definition.commands) {
				for (const [commandName, commandDef] of Object.entries(definition.commands)) {
					tools.push(createWorkerCommandTool(workerType, commandName, commandDef))
				}
			}
		}

		// Add generic worker control tools
		tools.push(
			createTool({
				name: 'worker_status',
				description: 'Get the current status and state of a worker.',
				input: z.object({
					workerId: workerIdSchema,
				}),
				execute: async (input, context) => {
					const result = await ctx.self.getStatus({
						sessionId: ctx.sessionState.id,
						agentId: context.agentId,
						workerId: input.workerId,
					})

					if (!result.ok) return Err({ message: result.error.message, recoverable: false })

					return Ok(JSON.stringify({
						status: result.value.status,
						state: result.value.state,
					}))
				},
			}),
			createTool({
				name: 'worker_cancel',
				description: 'Cancel a running or paused worker. It stops for good and cannot be resumed.',
				input: z.object({
					workerId: workerIdSchema,
				}),
				execute: async (input, context) => {
					const result = await ctx.self.cancel({
						sessionId: ctx.sessionState.id,
						agentId: context.agentId,
						workerId: input.workerId,
					})

					if (!result.ok) return Err({ message: result.error.message, recoverable: false })
					return Ok(JSON.stringify({ status: 'cancelled' }))
				},
			}),
			createTool({
				name: 'worker_pause',
				description: 'Pause a running worker. It stops where it is; worker_resume restarts it from the progress it had recorded.',
				input: z.object({
					workerId: workerIdSchema,
				}),
				execute: async (input, context) => {
					const result = await ctx.self.pause({
						sessionId: ctx.sessionState.id,
						agentId: context.agentId,
						workerId: input.workerId,
					})

					if (!result.ok) return Err({ message: result.error.message, recoverable: false })
					return Ok(JSON.stringify({ status: 'paused' }))
				},
			}),
			createTool({
				name: 'worker_resume',
				description: 'Resume a paused worker. It restarts from the progress it had recorded.',
				input: z.object({
					workerId: workerIdSchema,
				}),
				execute: async (input, context) => {
					const result = await ctx.self.resume({
						sessionId: ctx.sessionState.id,
						agentId: context.agentId,
						workerId: input.workerId,
					})

					if (!result.ok) return Err({ message: result.error.message, recoverable: false })
					return Ok(JSON.stringify({ status: 'resumed' }))
				},
			}),
		)

		return tools
	})
	.status((ctx) => {
		const workerTypes = ctx.pluginConfig.workers.map((w) => w.type)
		const visibleWorkerTypes = ctx.pluginAgentConfig?.workers ?? workerTypes
		const agentWorkers = Array.from(ctx.pluginState.values())
			.filter((w) => w.agentId === ctx.agentId && visibleWorkerTypes.includes(w.workerType))

		if (agentWorkers.length === 0) return null

		const lines: string[] = [
			'## Your Workers',
			'',
		]

		// Group by status
		const running = agentWorkers.filter((w) => w.status === 'running')
		const paused = agentWorkers.filter((w) => w.status === 'paused')
		const completed = agentWorkers.filter((w) => w.status === 'completed')
		const failed = agentWorkers.filter((w) => w.status === 'failed')

		if (running.length > 0) {
			lines.push('**Running:**')
			for (const worker of running) {
				lines.push(`- [${worker.id}] ${worker.workerType}`)
			}
			lines.push('')
		}

		if (paused.length > 0) {
			lines.push('**Paused:**')
			for (const worker of paused) {
				lines.push(`- [${worker.id}] ${worker.workerType}`)
			}
			lines.push('')
		}

		if (completed.length > 0) {
			lines.push('**Completed:**')
			for (const worker of completed) {
				lines.push(`- [${worker.id}] ${worker.workerType}`)
			}
			lines.push('')
		}

		if (failed.length > 0) {
			lines.push('**Failed:**')
			for (const worker of failed) {
				lines.push(`- [${worker.id}] ${worker.workerType}`)
			}
			lines.push('')
		}

		return lines.join('\n')
	})
	.build()
