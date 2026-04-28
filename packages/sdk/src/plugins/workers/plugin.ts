import z from 'zod/v4'
import { agentIdSchema } from '~/core/agents/schema.js'
import { ValidationErrors } from '~/core/errors.js'
import { createEventsFactory } from '~/core/events/types.js'
import type { BaseEvent } from '~/core/events/types.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createTool, type ToolDefinition } from '~/core/tools/definition.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { Logger } from '../../lib/logger/logger.js'
import { WorkerContextImpl } from './context.js'
import type { WorkerCommandDefinition, WorkerDefinition, WorkerSubEvent } from './definition.js'
import { generateWorkerId, type WorkerEntry, WorkerId, type WorkerId as WorkerIdType, workerIdSchema } from './worker.js'

export const workerEvents = createEventsFactory({
	events: {
		worker_started: z.object({
			workerId: workerIdSchema,
			agentId: agentIdSchema,
			workerType: z.string(),
			config: z.unknown(),
		}),
		worker_sub_event: z.object({
			workerId: workerIdSchema,
			workerType: z.string(),
			subEvent: z.record(z.string(), z.unknown()).and(z.object({
				type: z.string(),
			})),
		}),
		worker_status_changed: z.object({
			workerId: workerIdSchema,
			fromStatus: z.enum(['running', 'paused', 'completed', 'failed', 'cancelled']),
			toStatus: z.enum(['running', 'paused', 'completed', 'failed', 'cancelled']),
			reason: z.string().optional(),
		}),
		worker_completed: z.object({
			workerId: workerIdSchema,
			result: z.object({
				status: z.string(),
				resultsPath: z.string().optional(),
				summary: z.string(),
				data: z.unknown().optional(),
			}),
		}),
		worker_failed: z.object({
			workerId: workerIdSchema,
			error: z.string(),
			resumable: z.boolean(),
		}),
	},
})

export type WorkerStartedEvent = (typeof workerEvents)['Events']['worker_started']
export type WorkerSubEventEmittedEvent = (typeof workerEvents)['Events']['worker_sub_event']
export type WorkerStatusChangedEvent = (typeof workerEvents)['Events']['worker_status_changed']
export type WorkerCompletedEvent = (typeof workerEvents)['Events']['worker_completed']
export type WorkerFailedEvent = (typeof workerEvents)['Events']['worker_failed']

/**
 * Session-wide worker configuration.
 */
export interface WorkerPresetConfig {
	/** Available worker definitions */
	workers: WorkerDefinition[]
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
 * Event emitter callback - emits events without sessionId (added automatically).
 */
export type EmitEvent = (event: Omit<BaseEvent<string>, 'sessionId'>) => Promise<void>

/**
 * Represents a running worker instance.
 */
interface RunningWorker {
	workerId: WorkerId
	workerType: string
	definition: WorkerDefinition
	context: WorkerContextImpl<unknown, WorkerSubEvent>
	promise: Promise<void>
}

// ============================================================================
// Worker execution helper
// ============================================================================

async function executeWorker(
	workerId: WorkerId,
	definition: WorkerDefinition,
	config: unknown,
	context: WorkerContextImpl<unknown, WorkerSubEvent>,
	emitEvent: EmitEvent,
	runningWorkers: Map<WorkerIdType, RunningWorker>,
	logger: Logger,
): Promise<void> {
	try {
		const result = await definition.execute(config, context)

		if (result.ok) {
			await emitEvent(workerEvents.create('worker_completed', {
				workerId,
				result: result.value,
			}))
			logger.info('Worker completed', { workerId, result: result.value.summary })
		} else {
			await emitEvent(workerEvents.create('worker_failed', {
				workerId,
				error: result.error.message,
				resumable: result.error.resumable,
			}))
			logger.warn('Worker failed', { workerId, error: result.error.message, resumable: result.error.resumable })
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		await emitEvent(workerEvents.create('worker_failed', {
			workerId,
			error: message,
			resumable: false,
		}))
		logger.error('Worker threw exception', error instanceof Error ? error : undefined, { workerId })
	} finally {
		runningWorkers.delete(workerId)
	}
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
					if (!worker) return workers

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
					newWorkers.set(event.workerId, {
						...worker,
						status: event.toStatus,
						updatedAt: event.timestamp,
					})
					return newWorkers
				}

				case 'worker_completed': {
					const worker = workers.get(event.workerId)
					if (!worker) return workers

					const newWorkers = new Map(workers)
					newWorkers.set(event.workerId, {
						...worker,
						status: 'completed',
						updatedAt: event.timestamp,
					})
					return newWorkers
				}

				case 'worker_failed': {
					const worker = workers.get(event.workerId)
					if (!worker) return workers

					const newWorkers = new Map(workers)
					newWorkers.set(event.workerId, {
						...worker,
						status: 'failed',
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
		return { runningWorkers, logger: ctx.logger }
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

			// Emit worker started event
			await ctx.emitEvent(workerEvents.create('worker_started', {
				workerId,
				agentId: input.agentId,
				workerType: definition.type,
				config: validConfig,
			}))

			// Create context
			const workerContext = new WorkerContextImpl({
				sessionId: ctx.sessionId,
				workerId,
				agentId: input.agentId,
				workerType: definition.type,
				files: ctx.files.session,
				emitEvent: ctx.emitEvent,
				getSessionState: () => ctx.sessionState,
				reducer: definition.reduce as (state: unknown, event: WorkerSubEvent) => unknown,
				initialState: definition.initialState(validConfig),
				logger: logger.child({ workerId, workerType: definition.type }),
				schedule: () => ctx.scheduleAgent(input.agentId),
			})

			// Enforce max concurrent workers (default: 10)
			const MAX_CONCURRENT_WORKERS = 10
			if (runningWorkers.size >= MAX_CONCURRENT_WORKERS) {
				return Err(ValidationErrors.invalid(`Max concurrent workers reached (${MAX_CONCURRENT_WORKERS})`))
			}

			// Start worker execution with error boundary
			const promise = executeWorker(
				workerId,
				definition,
				validConfig,
				workerContext,
				ctx.emitEvent,
				runningWorkers,
				logger,
			).catch((err) => {
				logger.error('Unhandled error in worker execution', err instanceof Error ? err : undefined, { workerId })
			})

			// Track running worker
			runningWorkers.set(workerId, {
				workerId,
				workerType: definition.type,
				definition,
				context: workerContext,
				promise,
			})

			logger.info('Worker started', {
				sessionId: ctx.sessionId,
				workerId,
				workerType: definition.type,
				agentId: input.agentId,
			})

			return Ok({ workerId })
		},
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

			const definition = ctx.pluginConfig.workers.find((w) => w.type === worker.workerType)
			const state = definition?.summarizeState ? definition.summarizeState(worker.state) : worker.state

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
				return Err(ValidationErrors.invalid(`Worker not running: ${input.workerId}`))
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
			const worker = ctx.pluginContext.runningWorkers.get(workerId)
			if (!worker) {
				return Err(ValidationErrors.invalid(`Worker not running: ${input.workerId}`))
			}

			worker.context.cancel()

			const workerEntry = ctx.pluginState.get(workerId)
			const fromStatus = workerEntry?.status ?? 'running'

			await ctx.emitEvent(workerEvents.create('worker_status_changed', {
				workerId,
				fromStatus,
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
			const worker = ctx.pluginContext.runningWorkers.get(workerId)
			if (!worker) {
				return Err(ValidationErrors.invalid(`Worker not running: ${input.workerId}`))
			}

			const workerEntry = ctx.pluginState.get(workerId)
			const fromStatus = workerEntry?.status ?? 'running'

			if (fromStatus !== 'running') {
				return Err(ValidationErrors.invalid(`Worker not in running state: ${fromStatus}`))
			}

			worker.context.pause()

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
			const worker = ctx.pluginContext.runningWorkers.get(workerId)
			if (!worker) {
				return Err(ValidationErrors.invalid(`Worker not running: ${input.workerId}`))
			}

			const workerEntry = ctx.pluginState.get(workerId)
			const fromStatus = workerEntry?.status ?? 'paused'

			if (fromStatus !== 'paused') {
				return Err(ValidationErrors.invalid(`Worker not in paused state: ${fromStatus}`))
			}

			worker.context.resume()

			await ctx.emitEvent(workerEvents.create('worker_status_changed', {
				workerId,
				fromStatus,
				toStatus: 'running',
			}))

			return Ok({})
		},
	})
	.sessionHook('onSessionClose', async (ctx) => {
		const { runningWorkers, logger } = ctx.pluginContext
		if (runningWorkers.size === 0) return

		logger.info('Cancelling running workers on session close', { count: runningWorkers.size })

		// Cancel all running workers
		for (const worker of runningWorkers.values()) {
			worker.context.cancel()
		}

		// Await all worker promises with a timeout (5s)
		const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000))
		await Promise.race([
			Promise.allSettled([...runningWorkers.values()].map((w) => w.promise)),
			timeout,
		])

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
				description: 'Cancel a running worker. The worker will stop execution.',
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
				description: 'Pause a running worker. The worker can be resumed later.',
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
				description: 'Resume a paused worker.',
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
