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
 * A PDF carried in the message itself. An agent stores it in the session file store before its
 * history or events keep the message, so it never lands in the event log.
 */
export type InlineDocument = {
	mediaType: 'application/pdf'
	/** Base64 of the file bytes, without a `data:` prefix. */
	data: string
	filename?: string
}

/** A PDF in the session file store, read again for every inference that sends it. */
export type StoredDocument = {
	mediaType: 'application/pdf'
	/** Session-store path, `.documents/<sha256 of the bytes>.pdf`, read through the inference's file store. */
	path: string
	/** Decoded file size; the token estimate counts it in place of bytes it does not read. */
	byteLength: number
	filename?: string
}

/** A whole document handed to the model; providers that read PDFs natively see its pages, not extracted text. */
export type ChatMessageContentItemDocument = {
	type: 'document'
	document: InlineDocument | StoredDocument
}

/** A document with its bytes in hand, as a provider sends it. */
export type ChatMessageContentItemInlineDocument = {
	type: 'document'
	document: InlineDocument
}

/**
 * Union of all content item types.
 * Start with text and image, extend with audio/video as needed.
 */
export type ChatMessageContentItem =
	| ChatMessageContentItemText
	| ChatMessageContentItemImage
	| ChatMessageContentItemDocument

/** Content items once stored documents are read back — what a provider maps to its wire format. */
export type ResolvedContentItem =
	| ChatMessageContentItemText
	| ChatMessageContentItemImage
	| ChatMessageContentItemInlineDocument

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
	/** Opaque provider reasoning blocks, kept so a logged response can be replayed as the model sent it. */
	reasoningDetails?: unknown[]
	/** Anthropic thinking blocks, kept for the same reason. */
	thinkingBlocks?: unknown[]
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
	/** Sent again because a run that had already sent this request was interrupted before it committed the response. */
	retried?: boolean

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
