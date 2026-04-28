import { describe, expect, test } from 'bun:test'
import type { Result } from '~/lib/utils/result.js'
import { Ok } from '~/lib/utils/result.js'
import type { InferenceContext, InferenceRequest, InferenceResponse, LLMError, LLMProvider } from './provider.js'
import type { RoutableLLMProvider } from './routing-provider.js'
import { RoutingLLMProvider } from './routing-provider.js'
import { ModelId } from './schema.js'

// ============================================================================
// Helpers
// ============================================================================

const createRequest = (model: string): InferenceRequest => ({
	model: ModelId(model),
	systemPrompt: 'test',
	messages: [{ role: 'user', content: 'Hello' }],
})

const createMockProvider = (name: string, prefix: string): RoutableLLMProvider & { lastModel?: string } => {
	const provider: RoutableLLMProvider & { lastModel?: string } = {
		name,
		canHandle: (model: string) => model.startsWith(prefix),
		normalizeModel: (model: string) => model.startsWith(`${prefix}/`) ? model.slice(prefix.length + 1) : model,
		async inference(request: InferenceRequest): Promise<Result<InferenceResponse, LLMError>> {
			provider.lastModel = request.model
			return Ok({
				content: `Response from ${name}`,
				toolCalls: [],
				finishReason: 'stop',
				metrics: { promptTokens: 10, completionTokens: 5, totalTokens: 15, latencyMs: 100, model: request.model },
			})
		},
	}
	return provider
}

const createMockFallback = (name: string): LLMProvider & { lastModel?: string } => {
	const provider: LLMProvider & { lastModel?: string } = {
		name,
		async inference(request: InferenceRequest): Promise<Result<InferenceResponse, LLMError>> {
			provider.lastModel = request.model
			return Ok({
				content: `Response from ${name}`,
				toolCalls: [],
				finishReason: 'stop',
				metrics: { promptTokens: 10, completionTokens: 5, totalTokens: 15, latencyMs: 100, model: request.model },
			})
		},
	}
	return provider
}

// ============================================================================
// Tests
// ============================================================================

describe('RoutingLLMProvider', () => {
	test('routes to matching provider', async () => {
		const anthropic = createMockProvider('anthropic', 'anthropic')
		const fallback = createMockFallback('openrouter')

		const router = new RoutingLLMProvider([anthropic], fallback)
		const result = await router.inference(createRequest('anthropic/claude-sonnet-4.5'))

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value.content).toBe('Response from anthropic')
		}
		// Model should be normalized (prefix stripped)
		expect(anthropic.lastModel).toBe('claude-sonnet-4.5')
	})

	test('falls back to fallback provider when no match', async () => {
		const anthropic = createMockProvider('anthropic', 'anthropic')
		const fallback = createMockFallback('openrouter')

		const router = new RoutingLLMProvider([anthropic], fallback)
		const result = await router.inference(createRequest('openai/gpt-4o'))

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value.content).toBe('Response from openrouter')
		}
		// Model should be passed through unchanged to fallback
		expect(fallback.lastModel).toBe('openai/gpt-4o')
	})

	test('returns error when no provider matches and no fallback', async () => {
		const anthropic = createMockProvider('anthropic', 'anthropic')

		const router = new RoutingLLMProvider([anthropic])
		const result = await router.inference(createRequest('openai/gpt-4o'))

		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.type).toBe('invalid_request')
		}
	})

	test('first matching provider wins', async () => {
		const provider1 = createMockProvider('provider1', 'claude')
		const provider2 = createMockProvider('provider2', 'claude')
		const fallback = createMockFallback('fallback')

		const router = new RoutingLLMProvider([provider1, provider2], fallback)
		const result = await router.inference(createRequest('claude-sonnet-4.5'))

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value.content).toBe('Response from provider1')
		}
	})
})
