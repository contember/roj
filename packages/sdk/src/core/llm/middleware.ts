/**
 * LLM Middleware
 *
 * Composable middleware chain for LLM inference requests.
 * Middleware can modify requests, set provider-specific options,
 * force a specific provider, or implement retry/fallback logic.
 *
 * Chain order: preset middleware → agent middleware → base provider (RoutingLLMProvider).
 */

import type { Result } from '~/lib/utils/result.js'
import type {
	AnthropicRequestOptions,
	InferenceContext,
	InferenceRequest,
	InferenceResponse,
	LLMError,
	LLMProvider,
	OpenRouterRequestOptions,
} from './provider.js'

// ============================================================================
// Core types
// ============================================================================

/**
 * Next function in the middleware chain.
 * Call this to pass the (potentially modified) request to the next middleware or the base provider.
 */
export type InferenceNext = (
	request: InferenceRequest,
	context: InferenceContext,
) => Promise<Result<InferenceResponse, LLMError>>

/**
 * LLM middleware function.
 *
 * Can:
 * - Modify the request and call `next` (pass-through with modifications)
 * - Call a provider directly from `context.providers` (terminal — bypasses routing)
 * - Implement retry, fallback, or A/B logic around `next`
 */
export type LLMMiddleware = (
	request: InferenceRequest,
	context: InferenceContext,
	next: InferenceNext,
) => Promise<Result<InferenceResponse, LLMError>>

// ============================================================================
// Chain composition
// ============================================================================

/**
 * Wrap an LLMProvider with a middleware chain.
 *
 * Middleware is applied in order: first middleware in the array is outermost (runs first).
 * The base provider sits at the end of the chain.
 */
export function applyMiddleware(
	provider: LLMProvider,
	middleware: LLMMiddleware[],
): LLMProvider {
	if (middleware.length === 0) return provider

	const chain = middleware.reduceRight<InferenceNext>(
		(next, mw) => (req, ctx) => mw(req, ctx, next),
		(req, ctx) => provider.inference(req, ctx),
	)

	return {
		name: provider.name,
		inference: chain,
	}
}

// ============================================================================
// Built-in middleware factories
// ============================================================================

/**
 * Force a specific provider by name. Terminal — does NOT call `next`.
 *
 * The provider is resolved from `context.providers` at call time.
 *
 * @example
 * ```ts
 * // All agents in this preset use Anthropic directly:
 * createPreset({
 *   llmMiddleware: [useProvider('anthropic')],
 *   orchestrator: { model: ModelId('claude-sonnet-4'), ... },
 * })
 * ```
 */
export function useProvider(name: string): LLMMiddleware {
	return (_request, context, _next) => {
		const provider = context.providers?.get(name)
		if (!provider) {
			return Promise.resolve({
				ok: false as const,
				error: { type: 'invalid_request' as const, message: `Provider '${name}' is not available` },
			})
		}
		return provider.inference(_request, context)
	}
}

/**
 * Set OpenRouter-specific request options.
 *
 * @example
 * ```ts
 * // Exclude Google providers:
 * llmMiddleware: [withOpenRouter({ providers: { deny: ['Google'] } })]
 *
 * // Prefer specific providers:
 * llmMiddleware: [withOpenRouter({ providers: { order: ['Anthropic', 'AWS Bedrock'] } })]
 * ```
 */
export function withOpenRouter(opts: OpenRouterRequestOptions): LLMMiddleware {
	return (request, context, next) => {
		return next(
			{
				...request,
				openrouter: request.openrouter
					? { ...request.openrouter, ...opts }
					: opts,
			},
			context,
		)
	}
}

/**
 * Set Anthropic-specific request options.
 *
 * @example
 * ```ts
 * // Enable extended thinking for this agent:
 * llmMiddleware: [withAnthropic({ thinkingBudget: 50000 })]
 * ```
 */
export function withAnthropic(opts: AnthropicRequestOptions): LLMMiddleware {
	return (request, context, next) => {
		return next(
			{
				...request,
				anthropic: request.anthropic
					? { ...request.anthropic, ...opts }
					: opts,
			},
			context,
		)
	}
}

/**
 * Override max tokens for the request.
 */
export function withMaxTokens(maxTokens: number): LLMMiddleware {
	return (request, context, next) => {
		return next({ ...request, maxTokens }, context)
	}
}

/**
 * Override temperature for the request.
 */
export function withTemperature(temperature: number): LLMMiddleware {
	return (request, context, next) => {
		return next({ ...request, temperature }, context)
	}
}
