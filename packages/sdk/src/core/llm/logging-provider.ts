/**
 * LoggingLLMProvider - Wrapper that adds logging to any LLM provider
 */

import { AgentId } from '~/core/agents/schema.js'
import { SessionId } from '~/core/sessions/schema.js'
import type { Logger } from '~/lib/logger/logger.js'
import type { Result } from '~/lib/utils/result.js'
import type { LLMLogger } from './logger.js'
import type {
	InferenceContext,
	InferenceRequest,
	InferenceResponse,
	LLMError,
	LLMProvider,
	ProviderHttpRequest,
	RawInferenceRequest,
} from './provider.js'

/**
 * Wraps an LLM provider to add request/response logging.
 */
export class LoggingLLMProvider implements LLMProvider {
	readonly name: string

	constructor(
		private readonly provider: LLMProvider,
		private readonly logger: LLMLogger,
		private readonly runtimeLogger?: Logger,
	) {
		this.name = provider.name
	}

	async inference(
		request: InferenceRequest,
		context?: InferenceContext,
	): Promise<Result<InferenceResponse, LLMError>> {
		// Without context, just pass through
		if (!context) {
			return this.provider.inference(request)
		}

		const startTime = Date.now()
		const sessionId = SessionId(context.sessionId)
		const agentId = AgentId(context.agentId)

		// Create call entry and notify caller of the call ID
		const callId = await this.logger.createCall(sessionId, agentId, request)
		context.onLLMCallCreated?.(callId)

		const result = await this.provider.inference(request, context)
		const durationMs = Date.now() - startTime

		// Update call entry
		if (result.ok) {
			await this.logger.completeCall(sessionId, callId, result.value, durationMs)
		} else {
			await this.logger.failCall(sessionId, callId, result.error, durationMs)
		}

		return result
	}

	async buildHttpRequest(
		request: RawInferenceRequest,
		context?: InferenceContext,
	): Promise<ProviderHttpRequest> {
		if (!this.provider.buildHttpRequest) {
			throw new Error(`Provider ${this.provider.name} does not support buildHttpRequest`)
		}
		return this.provider.buildHttpRequest(request, context)
	}
}
