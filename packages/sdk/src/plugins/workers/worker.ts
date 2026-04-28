/**
 * Worker domain types and schemas
 *
 * Workers are long-running background processes (side-cars) that agents can spawn
 * and control. Each worker type has its own state slice, reducer, and emits sub-events.
 */

import { uuidv7 } from 'uuidv7'
import z from 'zod/v4'
import type { AgentId } from '../../core/agents/schema.js'

// ============================================================================
// WorkerId - Branded type
// ============================================================================

/** WorkerId schema - validates any string and brands as WorkerId. */
export const workerIdSchema = z.string().brand('WorkerId')

/** Branded WorkerId type */
export type WorkerId = z.infer<typeof workerIdSchema>

/** Constructor for WorkerId */
export const WorkerId = (id: string): WorkerId => id as WorkerId

/** Generate a new WorkerId (UUIDv7) */
export const generateWorkerId = (): WorkerId => WorkerId(uuidv7())

// ============================================================================
// WorkerId - Zod schemas
// ============================================================================

// ============================================================================
// Worker Status
// ============================================================================

/**
 * Worker execution status.
 */
export type WorkerStatus =
	| 'running'
	| 'paused'
	| 'completed'
	| 'failed'
	| 'cancelled'

// ============================================================================
// Worker Entry
// ============================================================================

/**
 * Worker entry in session state.
 * Tracks the worker's status and worker-specific state.
 */
export interface WorkerEntry {
	/** Worker instance ID */
	id: WorkerId
	/** Owning agent */
	agentId: AgentId
	/** Worker type (matches WorkerDefinition.type) */
	workerType: string
	/** Common status */
	status: WorkerStatus
	/** Worker-specific state (managed by worker's reducer) */
	state: unknown
	/** Configuration passed when starting the worker */
	config: unknown
	/** Timestamps */
	createdAt: number
	updatedAt: number
}

// ============================================================================
// Worker Result
// ============================================================================

/**
 * Result returned when a worker completes successfully.
 */
export interface WorkerResult {
	/** Completion status description */
	status: string
	/** Path to results file (if any) */
	resultsPath?: string
	/** Human-readable summary */
	summary: string
	/** Additional data */
	data?: unknown
}

/**
 * Error returned when a worker fails.
 */
export interface WorkerError {
	/** Error message */
	message: string
	/** Whether the worker can be resumed */
	resumable: boolean
	/** Additional error details */
	details?: unknown
}

// ============================================================================
// Worker Command
// ============================================================================

/**
 * Command sent from agent to worker.
 * Workers can optionally handle commands to receive instructions during execution.
 */
export interface WorkerCommand {
	/** Command name */
	command: string
	/** Command data */
	data?: unknown
}
