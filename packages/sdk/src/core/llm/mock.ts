import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { InferenceRequest, InferenceResponse, LLMError, LLMMetrics, LLMProvider } from './provider.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Handler type pro mock inference
 */
export type MockInferenceHandler = (
	request: InferenceRequest,
) => InferenceResponse | Promise<InferenceResponse>

// ============================================================================
// MockLLMProvider
// ============================================================================

/**
 * MockLLMProvider - callback-based mock pro testy
 */
export class MockLLMProvider implements LLMProvider {
	readonly name = 'mock'
	private handler: MockInferenceHandler
	private callHistory: InferenceRequest[] = []

	constructor(handler: MockInferenceHandler) {
		this.handler = handler
	}

	async inference(
		request: InferenceRequest,
	): Promise<Result<InferenceResponse, LLMError>> {
		this.callHistory.push(request)

		try {
			const response = await this.handler(request)
			return Ok(response)
		} catch (error) {
			if (this.isLLMError(error)) {
				return Err(error)
			}
			return Err({
				type: 'server_error',
				message: error instanceof Error ? error.message : String(error),
			})
		}
	}

	private isLLMError(error: unknown): error is LLMError {
		return (
			typeof error === 'object'
			&& error !== null
			&& 'type' in error
			&& 'message' in error
		)
	}

	// =========================================================================
	// Test helpers
	// =========================================================================

	/**
	 * Vrátí historii všech volání.
	 */
	getCallHistory(): InferenceRequest[] {
		return [...this.callHistory]
	}

	/**
	 * Vrátí počet volání.
	 */
	getCallCount(): number {
		return this.callHistory.length
	}

	/**
	 * Vymaže historii volání.
	 */
	clearHistory(): void {
		this.callHistory = []
	}

	/**
	 * Vrátí poslední request.
	 */
	getLastRequest(): InferenceRequest | undefined {
		return this.callHistory[this.callHistory.length - 1]
	}

	// =========================================================================
	// Factory methods
	// =========================================================================

	/**
	 * Vytvoří mock s fixní response.
	 */
	static withFixedResponse(
		response: Partial<InferenceResponse>,
	): MockLLMProvider {
		return new MockLLMProvider(() => ({
			content: response.content ?? null,
			toolCalls: response.toolCalls ?? [],
			finishReason: response.finishReason ?? 'stop',
			metrics: response.metrics ?? MockLLMProvider.defaultMetrics(),
		}))
	}

	/**
	 * Vytvoří mock se sekvencí responses.
	 */
	static withSequence(
		responses: Partial<InferenceResponse>[],
	): MockLLMProvider {
		let index = 0
		return new MockLLMProvider(() => {
			if (index >= responses.length) {
				throw new Error('No more mock responses available')
			}
			const response = responses[index++]
			return {
				content: response.content ?? null,
				toolCalls: response.toolCalls ?? [],
				finishReason: response.finishReason ?? 'stop',
				metrics: response.metrics ?? MockLLMProvider.defaultMetrics(),
			}
		})
	}

	/**
	 * Vytvoří mock který vždy selže.
	 */
	static withError(error: LLMError): MockLLMProvider {
		return new MockLLMProvider(() => {
			throw error
		})
	}

	/**
	 * Vytvoří mock který odpoví podle obsahu zpráv.
	 */
	static withMatcher(
		matchers: Array<{
			match: (request: InferenceRequest) => boolean
			response: Partial<InferenceResponse>
		}>,
		defaultResponse?: Partial<InferenceResponse>,
	): MockLLMProvider {
		return new MockLLMProvider((request) => {
			for (const { match, response } of matchers) {
				if (match(request)) {
					return {
						content: response.content ?? null,
						toolCalls: response.toolCalls ?? [],
						finishReason: response.finishReason ?? 'stop',
						metrics: response.metrics ?? MockLLMProvider.defaultMetrics(),
					}
				}
			}

			if (defaultResponse) {
				return {
					content: defaultResponse.content ?? null,
					toolCalls: defaultResponse.toolCalls ?? [],
					finishReason: defaultResponse.finishReason ?? 'stop',
					metrics: defaultResponse.metrics ?? MockLLMProvider.defaultMetrics(),
				}
			}

			throw new Error('No matching mock response found')
		})
	}

	/**
	 * Default metrics pro mock responses.
	 */
	static defaultMetrics(): LLMMetrics {
		return {
			promptTokens: 100,
			completionTokens: 50,
			totalTokens: 150,
			latencyMs: 100,
			model: 'mock',
		}
	}

	/**
	 * Default metrics with cost for mock responses.
	 */
	static defaultMetricsWithCost(cost: number): LLMMetrics {
		return {
			...MockLLMProvider.defaultMetrics(),
			cost,
		}
	}
}

// ============================================================================
// Request matchers
// ============================================================================

export const RequestMatchers = {
	/**
	 * Match pokud poslední message obsahuje text.
	 */
	lastMessageContains: (text: string) => (request: InferenceRequest): boolean => {
		const lastMessage = request.messages[request.messages.length - 1]
		if (!lastMessage) return false
		const content = lastMessage.content
		if (typeof content === 'string') return content.includes(text)
		// For array content, check if any text item contains the text
		return content.some((item) => item.type === 'text' && item.text.includes(text))
	},

	/**
	 * Match pokud system prompt obsahuje text.
	 */
	systemPromptContains: (text: string) => (request: InferenceRequest): boolean => {
		return request.systemPrompt.includes(text)
	},

	/**
	 * Match pokud je k dispozici určitý tool.
	 */
	hasTool: (toolName: string) => (request: InferenceRequest): boolean => {
		return request.tools?.some((t) => t.name === toolName) ?? false
	},

	/**
	 * Match vždy.
	 */
	always: (): (request: InferenceRequest) => boolean => () => true,
}
