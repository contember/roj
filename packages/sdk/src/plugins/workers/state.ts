/**
 * Worker domain events and the emitter shape.
 *
 * Lives here rather than in plugin.ts so that context.ts can import
 * `workerEvents` (a runtime value, produced by a top-level
 * createEventsFactory call) without depending on the plugin that also imports
 * WorkerContextImpl back from it. That was the repo's only two-way value cycle,
 * and a module-initialisation-order one at that. Matches mailbox, resources and
 * uploads, which all keep their events in state.ts.
 */
import z from 'zod/v4'
import { agentIdSchema } from '~/core/agents/schema.js'
import { createEventsFactory } from '~/core/events/types.js'
import type { BaseEvent } from '~/core/events/types.js'
import { workerIdSchema } from './worker.js'

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
 * Event emitter callback - emits events without sessionId (added automatically).
 */
export type EmitEvent = (event: Omit<BaseEvent<string>, 'sessionId'>) => Promise<void>
