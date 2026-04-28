/**
 * Todo domain types and schemas
 *
 * Todos are task items that agents can create, update, and track.
 * Each todo belongs to an agent and tracks its completion status.
 */

import { uuidv7 } from 'uuidv7'
import z from 'zod/v4'
import type { AgentId } from '~/core/agents'

// ============================================================================
// TodoId - Branded type
// ============================================================================

/** TodoId schema - validates any string and brands as TodoId. */
export const todoIdSchema = z.string().brand('TodoId')

/** Branded TodoId type */
export type TodoId = z.infer<typeof todoIdSchema>

/** Constructor for TodoId */
export const TodoId = (id: string): TodoId => id as TodoId

/** Generate a new TodoId (UUIDv7) */
export const generateTodoId = (): TodoId => TodoId(uuidv7())

// ============================================================================
// TodoId - Zod schemas
// ============================================================================

// ============================================================================
// Todo Status
// ============================================================================

/**
 * Todo completion status.
 */
export type TodoStatus =
	| 'pending'
	| 'in_progress'
	| 'completed'
	| 'cancelled'

// ============================================================================
// Todo Entry
// ============================================================================

/**
 * Todo entry in session state.
 * Tracks the todo's status, owner, and metadata.
 */
export interface TodoEntry {
	/** Todo instance ID */
	id: TodoId
	/** Owning agent */
	agentId: AgentId
	/** Todo title (short description) */
	title: string
	/** Optional detailed description */
	description?: string
	/** Current status */
	status: TodoStatus
	/** Optional metadata (tags, priority, etc.) */
	metadata?: Record<string, unknown>
	/** Timestamps */
	createdAt: number
	updatedAt: number
	completedAt?: number
	cancelledAt?: number
}
