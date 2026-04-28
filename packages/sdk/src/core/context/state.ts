import z4 from 'zod/v4'
import { agentIdSchema } from '~/core/agents'
import { createEventsFactory } from '~/core/events/types'

// ============================================================================
// Supporting types for context events
// ============================================================================

/**
 * Conversation message stored in event for reconstruction.
 */
export type CompactedConversationMessage = {
	role: 'user' | 'assistant' | 'system'
	content: string
}

// ============================================================================
// Context events
// ============================================================================

export const contextEvents = createEventsFactory({
	events: {
		context_compacted: z4.object({
			agentId: agentIdSchema,
			compactedContent: z4.string(),
			newConversationHistory: z4.array(z4.object({
				role: z4.enum(['user', 'assistant', 'system']),
				content: z4.string(),
			})),
			originalTokens: z4.number(),
			compactedTokens: z4.number(),
			messagesRemoved: z4.number(),
			historyPath: z4.string().optional(),
		}),
	},
})

export type ContextCompactedEvent = (typeof contextEvents)['Events']['context_compacted']
