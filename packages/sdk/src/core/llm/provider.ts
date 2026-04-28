import type { AssistantLLMMessage, LLMMessage, SystemLLMMessage, ToolCall, ToolLLMMessage, UserLLMMessage } from '~/core/agents/state.js'
import type { FileStore } from '~/core/file-store/types.js'
import type { ToolResultContent } from '~/core/llm/llm-log-types.js'
import type { ToolDefinition } from '~/core/tools/definition.js'
import type { ToolCallId } from '~/core/tools/schema.js'
import type { Result } from '~/lib/utils/result.js'
import { ModelId } from './schema'

// Re-export LLMMessage types from agents/state for backwards compatibility
export type { AssistantLLMMessage, LLMMessage, SystemLLMMessage, ToolCall, ToolLLMMessage, UserLLMMessage }

// ============================================================================
// Request types
// ============================================================================

/**
 * Raw tool spec without Zod dependency (for buildHttpRequest / curl export).
 */
export interface RawToolSpec {
	name: string
	description: string
	parameters: Record<string, unknown>
}

/**
 * OpenRouter-specific request options.
 * Set via `withOpenRouter()` middleware.
 *
 * @see https://openrouter.ai/docs/api-reference/overview
 */
export interface OpenRouterRequestOptions {
	/** Provider routing preferences */
	providers?: {
		/** Preferred provider ordering */
		order?: string[]
		/** Only allow these providers */
		allow?: string[]
		/** Exclude these providers */
		deny?: string[]
		/** Allowed quantizations (e.g. "bf16", "int8") */
		quantizations?: string[]
	}
	/** Routing strategy */
	route?: 'fallback'
	/** Model transforms */
	transforms?: string[]
	/** OpenRouter saved preset ID */
	preset?: string
}

/**
 * Anthropic-specific request options.
 * Set via `withAnthropic()` middleware.
 */
export interface AnthropicRequestOptions {
	/** Extended thinking token budget. Min 1024. Overrides server-level default. */
	thinkingBudget?: number
}

/**
 * Request pro LLM inference
 */
export interface InferenceRequest {
	model: ModelId
	systemPrompt: string
	messages: LLMMessage[]
	tools?: ToolDefinition<any>[]
	maxTokens?: number
	temperature?: number
	/** Stop sequences - LLM will stop generating when any of these are encountered */
	stopSequences?: string[]
	/** OpenRouter-specific options, set by middleware */
	openrouter?: OpenRouterRequestOptions
	/** Anthropic-specific options, set by middleware */
	anthropic?: AnthropicRequestOptions
}

/**
 * Raw inference request — uses plain JSON schemas instead of ToolDefinition.
 * Used by buildHttpRequest (and curl export from stored log entries).
 */
export interface RawInferenceRequest {
	model: ModelId
	systemPrompt: string
	messages: LLMMessage[]
	tools?: RawToolSpec[]
	maxTokens?: number
	temperature?: number
	stopSequences?: string[]
	/** OpenRouter-specific options, set by middleware */
	openrouter?: OpenRouterRequestOptions
	/** Anthropic-specific options, set by middleware */
	anthropic?: AnthropicRequestOptions
}

/**
 * Context for inference (for logging and call tracking).
 */
export interface InferenceContext {
	sessionId: string
	agentId: string
	/** Callback invoked when an LLM call entry is created, providing the call ID */
	onLLMCallCreated?: (callId: string) => void
	/** Signal to abort the inference request */
	signal?: AbortSignal
	/** FileStore for resolving file:// URLs in message content */
	fileStore: FileStore
	/** Named provider instances, available for middleware routing via useProvider() */
	providers?: ReadonlyMap<string, LLMProvider>
}

// ============================================================================
// HTTP request types (for curl export)
// ============================================================================

/**
 * Raw HTTP request as it would be sent to the provider API (without auth).
 */
export interface ProviderHttpRequest {
	url: string
	method: 'POST'
	headers: Record<string, string>
	body: unknown
}

// ============================================================================
// Response types
// ============================================================================

/**
 * Response z LLM inference
 */
export interface InferenceResponse {
	content: string | null
	toolCalls: ToolCall[]
	finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
	metrics: LLMMetrics
	/** Provider-specific request ID (e.g., OpenRouter generation ID for fetching stats) */
	providerRequestId?: string
	/** Extended thinking / reasoning content (for models that support it) */
	reasoning?: string
}

/**
 * Metriky z LLM volání
 */
export interface LLMMetrics {
	promptTokens: number
	completionTokens: number
	totalTokens: number
	latencyMs: number
	model: string
	/** Provider name (e.g. "anthropic", "openrouter") */
	provider?: string
	cost?: number
	/** Tokens served from prompt cache */
	cachedTokens?: number
	/** Tokens written to prompt cache */
	cacheWriteTokens?: number
	/** Reasoning/thinking tokens */
	reasoningTokens?: number
}

// ============================================================================
// Error types
// ============================================================================

/**
 * LLM error types
 */
export interface LLMError {
	type:
		| 'rate_limit'
		| 'invalid_request'
		| 'context_length'
		| 'server_error'
		| 'network_error'
		| 'timeout'
		| 'aborted'
	message: string
	retryAfterMs?: number
	/** HTTP status code from the provider response */
	statusCode?: number
	/** Raw HTTP response body from the provider */
	responseBody?: string
	cause?: unknown
}

// ============================================================================
// Provider interface
// ============================================================================

/**
 * LLMProvider interface
 */
export interface LLMProvider {
	/**
	 * Provede inference a vrátí response.
	 */
	inference(
		request: InferenceRequest,
		context?: InferenceContext,
	): Promise<Result<InferenceResponse, LLMError>>

	/**
	 * Build the raw HTTP request that would be sent to the provider API.
	 * Returns URL, headers (without auth), and body with resolved images.
	 * Used for curl export from debug UI.
	 */
	buildHttpRequest?(
		request: RawInferenceRequest,
		context?: InferenceContext,
	): Promise<ProviderHttpRequest>

	readonly name: string
}

// ============================================================================
// Message helpers
// ============================================================================

export const LLMMessageFactory = {
	user: (content: string): UserLLMMessage => ({ role: 'user', content }),

	assistant: (content: string, toolCalls?: ToolCall[]): AssistantLLMMessage => ({
		role: 'assistant',
		content,
		toolCalls,
	}),

	toolResult: (toolCallId: ToolCallId, content: ToolResultContent): ToolLLMMessage => ({
		role: 'tool',
		content,
		toolCallId,
	}),

	system: (content: string): SystemLLMMessage => ({ role: 'system', content }),
}
