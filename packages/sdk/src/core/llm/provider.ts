import type {
	AssistantLLMMessage,
	LLMMessage,
	ReasoningDetails,
	SystemLLMMessage,
	ThinkingBlocks,
	ToolCall,
	ToolLLMMessage,
	UserLLMMessage,
} from '~/core/agents/state.js'
import type { FileStore } from '~/core/file-store/types.js'
import type { ToolResultContent } from '~/core/llm/llm-log-types.js'
import type { ToolDefinition } from '~/core/tools/definition.js'
import type { ToolCallId } from '~/core/tools/schema.js'
import type { Result } from '~/lib/utils/result.js'
import { ProviderMessageValidationError } from './message-sanitization.js'
import { ModelId } from './schema.js'

// Re-export LLMMessage types from agents/state for backwards compatibility
export type { AssistantLLMMessage, LLMMessage, ReasoningDetails, SystemLLMMessage, ThinkingBlocks, ToolCall, ToolLLMMessage, UserLLMMessage }

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
export interface OpenRouterProviderRouting {
	/** Preferred provider ordering */
	order?: string[]
	/** Only allow these providers */
	only?: string[]
	/** Exclude these providers */
	ignore?: string[]
	/** Whether to allow backup providers */
	allow_fallbacks?: boolean
	/** Allowed quantizations (e.g. "bf16", "int8") */
	quantizations?: string[]
}

/**
 * Reasoning controls.
 *
 * Without these the model's own default applies, and several of the defaults are expensive:
 * `high` on Claude Sonnet 5, Opus 5 and Grok 4.5, `max` on Kimi K3. Reasoning is also
 * `mandatory` on Gemini 3.6 Flash, Grok 4.5 and Kimi K2.7 Code — those cannot be turned off,
 * only turned down.
 *
 * **Which efforts a model accepts differs per model.** The catalog's
 * `reasoning.supported_efforts` is the authority: Kimi K3 has no `medium`, `minimal` exists
 * only on Gemini, `xhigh`/`none` only on the OpenAI and newer Anthropic models. The union here
 * is every value seen across them, not a set any single model takes.
 *
 * @see https://openrouter.ai/docs/use-cases/reasoning-tokens
 */
export interface OpenRouterReasoningOptions {
	/** Relative budget. Mutually exclusive with `max_tokens` — set one. */
	effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
	/** Absolute token budget, for models that take one instead of an effort. */
	max_tokens?: number
	/** Explicitly enable reasoning at the model's default effort. */
	enabled?: boolean
	/** Reason, but omit the blocks from the response. Note this breaks the round trip. */
	exclude?: boolean
}

export interface OpenRouterRequestOptions {
	/** Provider routing preferences */
	providers?: OpenRouterProviderRouting
	/** Reasoning budget. Omitted: the model's own default, which is often `high`. */
	reasoning?: OpenRouterReasoningOptions
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
	/** Extended thinking / reasoning content (for models that support it) — human-readable, for logs and the debug UI. */
	reasoning?: string
	/** Opaque reasoning blocks to echo back on the next request. Absent for models that do not reason. */
	reasoningDetails?: ReasoningDetails
	/** Anthropic thinking blocks to replay on the next request. Absent unless extended thinking is enabled. */
	thinkingBlocks?: ThinkingBlocks
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

// ============================================================================
// Error mapping
// ============================================================================

/**
 * Maps a thrown provider error onto an LLMError.
 *
 * `timedOut` distinguishes our own request timeout from a caller-initiated
 * cancel: both abort the same controller and surface as an indistinguishable
 * AbortError, but only the timeout is retryable. Mapping a timeout to 'aborted'
 * makes Agent.runInference bail silently and leave the agent stuck 'inferring'.
 */
export function mapProviderError(err: unknown, opts?: { timedOut?: boolean }): LLMError {
	if (err instanceof ProviderMessageValidationError) {
		return { type: 'invalid_request', message: err.message }
	}
	if (err instanceof Error && err.name === 'AbortError') {
		return opts?.timedOut
			? { type: 'timeout', message: 'Request timed out', cause: err }
			: { type: 'aborted', message: 'Request was aborted' }
	}
	if (err instanceof TypeError && (err.message.includes('fetch') || err.message.includes('network'))) {
		return { type: 'network_error', message: err.message, cause: err }
	}
	return { type: 'network_error', message: err instanceof Error ? err.message : String(err), cause: err }
}
