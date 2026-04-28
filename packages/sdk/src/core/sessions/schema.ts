/**
 * Session domain types and schemas
 *
 * Contains all types related to sessions:
 * - Branded ID type and constructor
 * - Session metadata schemas
 * - Zod schemas for validation
 */

import { uuidv7 } from 'uuidv7'
import z from 'zod/v4'

// ============================================================================
// SessionId - Branded type
// ============================================================================

/** SessionId schema - validates any string and brands as SessionId. */
export const sessionIdSchema = z.string().brand('SessionId')

/** Branded SessionId type */
export type SessionId = z.infer<typeof sessionIdSchema>

/** Constructor for SessionId */
export const SessionId = (id: string): SessionId => id as SessionId

/** Generate a new SessionId (UUIDv7) */
export const generateSessionId = (): SessionId => SessionId(uuidv7())

// ============================================================================
// SessionId - Zod schemas
// ============================================================================

// ============================================================================
// Session metadata schemas
// ============================================================================

export const sessionMetadataMetricsSchema = z.object({
	totalEvents: z.number().int().min(0),
	totalAgents: z.number().int().min(0),
	totalTokens: z.number().int().min(0),
	totalLLMCalls: z.number().int().min(0),
	inputTokens: z.number().int().min(0).optional(),
	outputTokens: z.number().int().min(0).optional(),
	totalCost: z.number().min(0).optional(),
	totalMessages: z.number().int().min(0).optional(),
	totalToolCalls: z.number().int().min(0).optional(),
})

export const sessionMetadataSchema = z.object({
	sessionId: sessionIdSchema,
	presetId: z.string(),
	createdAt: z.number(),
	lastActivityAt: z.number(),
	status: z.enum(['active', 'closed', 'errored']),
	name: z.string().optional(),
	tags: z.array(z.string()).optional(),
	metrics: sessionMetadataMetricsSchema.optional(),
	custom: z.record(z.string(), z.unknown()).optional(),
})

export const listSessionsOptionsSchema = z.object({
	status: z.enum(['active', 'closed', 'errored']).optional(),
	tags: z.array(z.string()).optional(),
	limit: z.number().int().min(1).max(100).optional(),
	offset: z.number().int().min(0).optional(),
	orderBy: z.enum(['createdAt', 'lastActivityAt']).optional(),
	order: z.enum(['asc', 'desc']).optional(),
})

// ============================================================================
// Type exports (inferred from schemas)
// ============================================================================

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>
export type SessionMetadataMetrics = z.infer<typeof sessionMetadataMetricsSchema>
export type ListSessionsOptions = z.infer<typeof listSessionsOptionsSchema>

// ============================================================================
// Domain event schema (for loading from file)
// ============================================================================

export const domainEventSchema = z
	.object({
		type: z.string(),
		sessionId: z.string(),
		timestamp: z.number(),
	})
	.passthrough()

export type DomainEventInput = z.infer<typeof domainEventSchema>
export type SessionMetadataInput = z.infer<typeof sessionMetadataSchema>
