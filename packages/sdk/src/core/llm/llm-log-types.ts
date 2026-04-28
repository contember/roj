import type { AgentId } from '~/core/agents/schema.js'
import type { AnthropicRequestOptions, OpenRouterRequestOptions } from '~/core/llm/provider.js'
import type { LLMCallId } from '~/core/llm/schema.js'
import type { SessionId } from '~/core/sessions/schema.js'
import type { ToolCallId } from '~/core/tools/schema.js'
import type { LLMToolCall } from './state.js'

export type ChatMessageContentItemText = {
	type: 'text'
	text: string
	cacheControl?: { type: 'ephemeral' }
}

export type ChatMessageContentItemImageDetail = 'auto' | 'low' | 'high'

export type ChatMessageContentItemImage = {
	type: 'image_url'
	imageUrl: {
		url: string
		detail?: ChatMessageContentItemImageDetail
	}
}

/**
 * Union of all content item types.
 * Start with text and image, extend with audio/video as needed.
 */
export type ChatMessageContentItem =
	| ChatMessageContentItemText
	| ChatMessageContentItemImage

/**
 * Tool result content - string or array of content items.
 * Matches OpenRouter's ToolResponseMessageContent type.
 */
export type ToolResultContent = string | ChatMessageContentItem[]

/**
 * Helper to normalize content to string (for display/logging).
 */
export const contentToString = (content: ToolResultContent): string => {
	if (typeof content === 'string') return content
	return content
		.filter((c): c is ChatMessageContentItemText => c.type === 'text')
		.map((c) => c.text)
		.join('\n')
}

/**
 * Represents an LLM message in the request.
 */
export type LLMCallMessage = {
	role: 'user' | 'assistant' | 'tool' | 'system'
	content: string | ChatMessageContentItem[]
	toolCalls?: LLMToolCall[]
	toolCallId?: ToolCallId
	/** Assistant reasoning (for models that support it) */
	reasoning?: string
	/** Prompt cache breakpoint marker (ephemeral cache checkpoint after this message) */
	cacheControl?: { type: 'ephemeral' }
}

/**
 * Tool definition for logging (includes full JSON schema).
 */
export type LLMCallToolDefinition = {
	name: string
	description: string
	/** JSON Schema for tool parameters */
	parameters?: Record<string, unknown>
}

/**
 * Request data stored in the log entry.
 */
export type LLMCallRequest = {
	model: string
	systemPrompt: string
	messages: LLMCallMessage[]
	tools?: LLMCallToolDefinition[]
	toolsCount: number
	maxTokens?: number
	temperature?: number
	/** Provider-specific options set by middleware */
	providerOptions?: {
		openrouter?: OpenRouterRequestOptions
		anthropic?: AnthropicRequestOptions
	}
}

/**
 * Response data stored in the log entry.
 */
export type LLMCallResponse = {
	content: string | null
	toolCalls: LLMToolCall[]
	finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
	/** Assistant reasoning (for models that support extended thinking) */
	reasoning?: string
}

/**
 * Extended metrics with detailed token breakdown.
 */
export type LLMCallMetrics = {
	promptTokens: number
	completionTokens: number
	totalTokens: number
	/** Reasoning/thinking tokens (for models like o1, Claude with extended thinking) */
	reasoningTokens?: number
	/** Cached prompt tokens (for providers with prompt caching) */
	cachedTokens?: number
	/** Tokens written to prompt cache */
	cacheWriteTokens?: number
	latencyMs: number
	/** Generation time (actual model inference time) */
	generationTimeMs?: number
	model: string
	/** Provider name (e.g., "anthropic", "openai") */
	provider?: string
	cost?: number
	/** Cache status */
	cacheStatus?: 'hit' | 'miss' | 'none'
}

/**
 * Error data stored in the log entry.
 */
export type LLMCallError = {
	type: string
	message: string
	retryAfterMs?: number
	/** HTTP status code from the provider response */
	statusCode?: number
	/** Raw HTTP response body from the provider */
	responseBody?: string
}

/**
 * Complete LLM call log entry.
 * Each entry represents a single LLM API call with full request/response details.
 */
export type LLMCallLogEntry = {
	id: LLMCallId
	sessionId: SessionId
	agentId: AgentId
	createdAt: number
	completedAt?: number
	durationMs?: number
	status: 'running' | 'success' | 'error'

	request: LLMCallRequest
	response?: LLMCallResponse
	metrics?: LLMCallMetrics
	error?: LLMCallError

	/** Provider-specific request ID (e.g., OpenRouter generation ID) */
	providerRequestId?: string
}

/**
 * Response for listing LLM calls.
 */
export type GetLLMCallsResponse = {
	calls: LLMCallLogEntry[]
	total: number
}
