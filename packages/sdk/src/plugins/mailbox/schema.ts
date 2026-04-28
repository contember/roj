/**
 * Message domain types and schemas
 *
 * Contains all types related to messages:
 * - Branded ID type and constructor
 * - Mailbox types
 * - AskUser input types
 * - Zod schemas for validation
 */

import z from 'zod/v4'
import { COMMUNICATOR_ROLE, ORCHESTRATOR_ROLE } from '../../core/agents/agent-roles.js'
import type { AgentId } from '../../core/agents/schema.js'
import type { MessageAttachment } from '../uploads/schema.js'
import type { WorkerId } from '../workers/worker.js'

// ============================================================================
// MessageId - Branded type
// ============================================================================

/** MessageId schema - validates any string and brands as MessageId. */
export const messageIdSchema = z.string().brand('MessageId')

/** Branded MessageId type */
export type MessageId = z.infer<typeof messageIdSchema>

/** Constructor for MessageId */
export const MessageId = (id: string): MessageId => id as MessageId

/**
 * Generate a short message ID.
 * Format: m{seq} e.g., "m1", "m42"
 */
export const generateMessageId = (seq: number): MessageId => MessageId(`m${seq}`)

// ============================================================================
// Test helpers
// ============================================================================

let testCounter = 0

/**
 * Generate a test message ID (for tests only).
 * Uses incrementing counter for uniqueness.
 */
export const generateTestMessageId = (): MessageId => MessageId(`m${++testCounter}`)

// ============================================================================
// Mailbox types
// ============================================================================

/**
 * Sender of a mailbox message.
 * Can be an agent, user, system roles, or a worker.
 */
export type MailboxMessageSender =
	| AgentId
	| WorkerId
	| 'user'
	| 'debug'
	| typeof ORCHESTRATOR_ROLE
	| typeof COMMUNICATOR_ROLE

/**
 * Message in an agent's mailbox.
 */
export type MailboxMessage = {
	id: MessageId
	from: MailboxMessageSender
	content: string
	timestamp: number
	consumed: boolean
	/** If this message is an answer to a question, the question's message ID */
	answerTo?: MessageId
	/** The answer value (JSON-serializable), only present when answerTo is set */
	answerValue?: unknown
	/** File attachments uploaded with this message */
	attachments?: MessageAttachment[]
	/** Optional context visible to LLM but not displayed in chat UI */
	context?: string
}
