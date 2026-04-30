import z4 from 'zod/v4'
import { agentIdSchema } from '~/core/agents'
import type { LLMMessage } from '~/core/agents/state'
import { createEventsFactory } from '~/core/events/types'
import { toolCallIdSchema } from '~/core/tools/schema'
import { messageIdSchema } from '~/plugins/mailbox/schema'
import { llmCallIdSchema } from './schema.js'

// ============================================================================
// Supporting types for LLM events
// ============================================================================

/**
 * LLM response content - can be text and/or tool calls.
 */
export type LLMResponse = {
	content: string | null
	toolCalls: LLMToolCall[]
}

/**
 * A single tool call from the LLM.
 */
export type LLMToolCall = {
	id: string // ToolCallId
	name: string
	input: unknown
}

/**
 * Metrics from an LLM inference call.
 */
export type LLMMetrics = {
	promptTokens: number
	completionTokens: number
	totalTokens: number
	latencyMs: number
	model: string
	provider?: string
	cost?: number
	/** Tokens served from prompt cache (cache read) */
	cachedTokens?: number
	/** Tokens written to prompt cache */
	cacheWriteTokens?: number
}

// ============================================================================
// LLM events
// ============================================================================

export const llmEvents = createEventsFactory({
	events: {
		inference_started: z4.object({
			agentId: agentIdSchema,
			messages: z4.array(z4.custom<LLMMessage>()),
			consumedMessageIds: z4.array(messageIdSchema),
		}),
		inference_completed: z4.object({
			agentId: agentIdSchema,
			consumedMessageIds: z4.array(messageIdSchema),
			response: z4.object({
				content: z4.string().nullable(),
				toolCalls: z4.array(z4.object({
					id: toolCallIdSchema,
					name: z4.string(),
					input: z4.unknown(),
				})),
			}),
			metrics: z4.object({
				promptTokens: z4.number(),
				completionTokens: z4.number(),
				totalTokens: z4.number(),
				latencyMs: z4.number(),
				model: z4.string(),
				provider: z4.string().optional(),
				cost: z4.number().optional(),
				cachedTokens: z4.number().optional(),
				cacheWriteTokens: z4.number().optional(),
			}),
			llmCallId: llmCallIdSchema.optional(),
		}),
		inference_failed: z4.object({
			agentId: agentIdSchema,
			error: z4.string(),
			llmCallId: llmCallIdSchema.optional(),
		}),
	},
})

export type InferenceStartedEvent = (typeof llmEvents)['Events']['inference_started']
export type InferenceCompletedEvent = (typeof llmEvents)['Events']['inference_completed']
export type InferenceFailedEvent = (typeof llmEvents)['Events']['inference_failed']
