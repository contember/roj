/**
 * RoutingLLMProvider - Routes requests to the appropriate provider based on model ID.
 *
 * Each registered provider declares which models it can handle via `canHandle()`.
 * The last registered provider acts as the fallback (typically OpenRouter).
 */

import type { Result } from '~/lib/utils/result.js'
import { Err } from '~/lib/utils/result.js'
import type {
	InferenceContext,
	InferenceRequest,
	InferenceResponse,
	LLMError,
	LLMProvider,
	ProviderHttpRequest,
	RawInferenceRequest,
} from './provider.js'
import { ModelId } from './schema.js'

/**
 * A provider that can declare which models it supports.
 */
export interface RoutableLLMProvider extends LLMProvider {
	/** Returns true if this provider can handle the given model ID. */
	canHandle(model: string): boolean
	/** Normalizes the model ID for this provider (e.g. strips vendor prefix). */
	normalizeModel(model: string): string
}

/**
 * Routes inference requests to the appropriate provider based on model ID.
 * Providers are checked in order; first match wins.
 * If no provider matches, the fallback provider is used.
 */
export class RoutingLLMProvider implements LLMProvider {
	readonly name = 'routing'

	constructor(
		private readonly providers: RoutableLLMProvider[],
		private readonly fallback?: LLMProvider,
	) {}

	async inference(
		request: InferenceRequest,
		context?: InferenceContext,
	): Promise<Result<InferenceResponse, LLMError>> {
		const model = request.model

		for (const provider of this.providers) {
			if (provider.canHandle(model)) {
				const normalizedModel = ModelId(provider.normalizeModel(model))
				return provider.inference({ ...request, model: normalizedModel }, context)
			}
		}

		if (this.fallback) {
			return this.fallback.inference(request, context)
		}

		return Err({
			type: 'invalid_request',
			message: `No provider available for model: ${model}`,
		})
	}

	async buildHttpRequest(
		request: RawInferenceRequest,
		context?: InferenceContext,
	): Promise<ProviderHttpRequest> {
		const model = request.model

		for (const provider of this.providers) {
			if (provider.canHandle(model) && provider.buildHttpRequest) {
				const normalizedModel = ModelId(provider.normalizeModel(model))
				return provider.buildHttpRequest({ ...request, model: normalizedModel }, context)
			}
		}

		if (this.fallback?.buildHttpRequest) {
			return this.fallback.buildHttpRequest(request, context)
		}

		throw new Error(`No provider with buildHttpRequest available for model: ${model}`)
	}
}
