import z4 from 'zod/v4'
import { agentIdSchema } from '~/core/agents'
import type { LLMMessage } from '~/core/agents/state.js'
import { createEventsFactory } from '~/core/events/types'
import { toolCallIdSchema } from '~/core/tools/schema.js'
import { messageIdSchema } from '~/plugins/mailbox/schema.js'

// ============================================================================
// Supporting types for context events
// ============================================================================

/**
 * Conversation message stored in the event for lossless reconstruction.
 */
export type CompactedConversationMessage = LLMMessage

const cacheControlSchema = z4.object({
	type: z4.literal('ephemeral'),
	ttl: z4.enum(['5m', '1h']).optional(),
})

const contentItemSchema = z4.discriminatedUnion('type', [
	z4.object({
		type: z4.literal('text'),
		text: z4.string(),
		cacheControl: z4.object({
			type: z4.literal('ephemeral'),
		}).optional(),
	}),
	z4.object({
		type: z4.literal('image_url'),
		imageUrl: z4.object({
			url: z4.string(),
			detail: z4.enum(['auto', 'low', 'high']).optional(),
		}),
	}),
])

const messageContentSchema = z4.union([
	z4.string(),
	z4.array(contentItemSchema),
])

export const compactedConversationMessageSchema: z4.ZodType<LLMMessage> = z4.discriminatedUnion('role', [
	z4.object({
		role: z4.literal('user'),
		content: messageContentSchema,
		sourceMessageIds: z4.array(messageIdSchema).optional(),
		cacheControl: cacheControlSchema.optional(),
	}),
	z4.object({
		role: z4.literal('assistant'),
		content: z4.string(),
		toolCalls: z4.array(z4.object({
			id: toolCallIdSchema,
			name: z4.string(),
			input: z4.unknown(),
		})).optional(),
		/** Opaque provider reasoning blocks — retained turns keep them, see ReasoningDetails. */
		reasoningDetails: z4.array(z4.unknown()).optional(),
		/** Anthropic thinking blocks — same. */
		thinkingBlocks: z4.array(z4.unknown()).optional(),
		cacheControl: cacheControlSchema.optional(),
	}),
	z4.object({
		role: z4.literal('tool'),
		content: messageContentSchema,
		toolCallId: toolCallIdSchema,
		toolName: z4.string().optional(),
		isError: z4.boolean().optional(),
		timestamp: z4.number().optional(),
		cacheControl: cacheControlSchema.optional(),
	}),
	z4.object({
		role: z4.literal('system'),
		content: z4.string(),
		cacheControl: cacheControlSchema.optional(),
	}),
])

export const contextCompactedEventSchema = z4.object({
	agentId: agentIdSchema,
	compactedContent: z4.string(),
	/**
	 * Display-only snapshot of the messages that were summarized away (the
	 * "input" of the compaction). Not used for conversation reconstruction —
	 * that's driven by newConversationHistory. Optional for backward
	 * compatibility with events emitted before this field existed.
	 */
	originalMessages: z4.array(z4.object({
		role: z4.enum(['user', 'assistant', 'system']),
		content: z4.string(),
	})).optional(),
	newConversationHistory: z4.array(compactedConversationMessageSchema),
	originalTokens: z4.number(),
	compactedTokens: z4.number(),
	messagesRemoved: z4.number(),
	historyPath: z4.string().optional(),
})

// ============================================================================
// Context events
// ============================================================================

export const contextEvents = createEventsFactory({
	events: {
		context_compacted: contextCompactedEventSchema,
	},
})

export type ContextCompactedEvent = (typeof contextEvents)['Events']['context_compacted']
