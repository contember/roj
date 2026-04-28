import type { ToolCall } from '~/core/agents/state.js'
import type { ImageProcessor } from '~/core/image/types.js'
import type { ChatMessageContentItem } from '~/core/llm/llm-log-types.js'
import { ToolCallId } from '~/core/tools/schema.js'
import type { Logger } from '~/lib/logger/logger.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type {
	InferenceContext,
	InferenceRequest,
	InferenceResponse,
	LLMError,
	LLMMessage,
	LLMMetrics,
	LLMProvider,
	ProviderHttpRequest,
	RawInferenceRequest,
} from './provider.js'

// ============================================================================
// Configuration
// ============================================================================

export interface OpenRouterConfig {
	apiKey: string
	defaultModel?: string
	timeout?: number
	logger?: Logger
	imageProcessor: ImageProcessor
	/** Custom fetch function (for testing/caching). Defaults to globalThis.fetch. */
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

// ============================================================================
// OpenRouter API types
// ============================================================================

interface OpenRouterToolCallFunction {
	name: string
	arguments: string
}

interface OpenRouterToolCall {
	id: string
	type: 'function'
	function: OpenRouterToolCallFunction
}

interface OpenRouterChoice {
	message: {
		content: string | null | Array<{ type: string; text?: string }>
		tool_calls?: OpenRouterToolCall[]
	}
	finish_reason: string | null
}

interface OpenRouterUsage {
	prompt_tokens: number
	completion_tokens: number
	total_tokens: number
	cost?: number
	prompt_tokens_details?: {
		cached_tokens?: number
		cache_write_tokens?: number
	}
	completion_tokens_details?: {
		reasoning_tokens?: number
	}
}

interface OpenRouterResponse {
	id: string
	model: string
	choices: OpenRouterChoice[]
	usage?: OpenRouterUsage
}

interface OpenRouterErrorResponse {
	error?: {
		message: string
		type?: string
		code?: string
	}
}

// ============================================================================
// Request body types
// ============================================================================

interface OpenRouterContentItem {
	type: string
	text?: string
	image_url?: { url: string; detail?: string }
	cache_control?: { type: 'ephemeral' }
}

interface OpenRouterMessage {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content: string | OpenRouterContentItem[]
	tool_calls?: OpenRouterToolCall[]
	tool_call_id?: string
}

/**
 * Add `cache_control: { type: 'ephemeral' }` to the LAST content block of an
 * OpenRouterMessage, converting string content to an array text block first
 * so the mark has a place to live.
 */
function applyCacheControlToLastBlock(msg: OpenRouterMessage): void {
	if (typeof msg.content === 'string') {
		msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }]
		return
	}
	if (msg.content.length === 0) return
	const lastIdx = msg.content.length - 1
	msg.content[lastIdx] = { ...msg.content[lastIdx], cache_control: { type: 'ephemeral' } }
}

interface OpenRouterToolDefinition {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: Record<string, unknown>
	}
}

interface OpenRouterProviderRouting {
	order?: string[]
	allow?: string[]
	deny?: string[]
	quantizations?: string[]
}

interface OpenRouterRequestBody {
	model: string
	messages: OpenRouterMessage[]
	tools?: OpenRouterToolDefinition[]
	max_tokens?: number
	temperature?: number
	stop?: string[]
	stream: false
	stream_options: { include_usage: true }
	/** Provider routing preferences */
	provider?: OpenRouterProviderRouting
	/** Routing strategy */
	route?: 'fallback'
	/** Model transforms */
	transforms?: string[]
	/** OpenRouter saved preset ID */
	preset?: string
}

// ============================================================================
// OpenRouterProvider
// ============================================================================

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'

export class OpenRouterProvider implements LLMProvider {
	readonly name = 'openrouter'
	private apiKey: string
	private defaultModel: string
	private logger?: Logger
	private imageProcessor: ImageProcessor
	private timeout: number
	private fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>

	constructor(config: OpenRouterConfig) {
		this.apiKey = config.apiKey
		this.defaultModel = config.defaultModel ?? 'anthropic/claude-sonnet-4.5'
		this.logger = config.logger
		this.imageProcessor = config.imageProcessor
		this.timeout = config.timeout ?? 120000
		this.fetchFn = config.fetch ?? globalThis.fetch
	}

	async inference(request: InferenceRequest, context?: InferenceContext): Promise<Result<InferenceResponse, LLMError>> {
		const startTime = Date.now()

		try {
			const rawRequest: RawInferenceRequest = {
				...request,
				tools: request.tools?.map((t) => ({
					name: t.name,
					description: t.description,
					parameters: t.input.toJSONSchema(),
				})),
			}

			const httpRequest = await this.buildHttpRequest(rawRequest, context)

			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), this.timeout)

			if (context?.signal) {
				context.signal.addEventListener('abort', () => controller.abort(), { once: true })
			}

			let response: Response
			try {
				response = await this.fetchFn(httpRequest.url, {
					method: httpRequest.method,
					headers: {
						...httpRequest.headers,
						'Authorization': `Bearer ${this.apiKey}`,
					},
					body: JSON.stringify(httpRequest.body),
					signal: controller.signal,
				})
			} finally {
				clearTimeout(timeoutId)
			}

			if (!response.ok) {
				const body = await response.text()
				return Err(this.mapHttpError(response.status, body))
			}

			const data = await response.json() as OpenRouterResponse
			const latencyMs = Date.now() - startTime

			const choice = data.choices[0]
			if (!choice) {
				return Err({ type: 'server_error', message: 'No choices returned from LLM' })
			}

			const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map(
				(tc) => ({
					id: ToolCallId(tc.id),
					name: tc.function.name,
					input: this.parseToolArguments(tc.function.arguments),
				}),
			)

			const promptTokens = data.usage?.prompt_tokens ?? 0
			const completionTokens = data.usage?.completion_tokens ?? 0
			const cost = data.usage?.cost

			const metrics: LLMMetrics = {
				promptTokens,
				completionTokens,
				totalTokens: data.usage?.total_tokens ?? 0,
				latencyMs,
				model: data.model,
				provider: this.name,
				cost,
				cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens || undefined,
				cacheWriteTokens: data.usage?.prompt_tokens_details?.cache_write_tokens || undefined,
				reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens || undefined,
			}

			return Ok({
				content: this.extractContent(choice.message.content),
				toolCalls,
				finishReason: this.mapFinishReason(choice.finish_reason),
				metrics,
				providerRequestId: data.id,
			})
		} catch (error) {
			return Err(this.mapError(error))
		}
	}

	async buildHttpRequest(request: RawInferenceRequest, context?: InferenceContext): Promise<ProviderHttpRequest> {
		const mappedMessages = await Promise.all(request.messages.map((m) => this.mapMessage(m, context)))

		const messages: OpenRouterMessage[] = [
			{ role: 'system', content: [{ type: 'text', text: request.systemPrompt, cache_control: { type: 'ephemeral' } }] },
			...mappedMessages,
		]

		const body: OpenRouterRequestBody = {
			model: request.model ?? this.defaultModel,
			messages,
			max_tokens: request.maxTokens,
			temperature: request.temperature,
			stop: request.stopSequences,
			stream: false,
			stream_options: { include_usage: true },
		}

		if (request.tools?.length) {
			body.tools = request.tools.map((t): OpenRouterToolDefinition => ({
				type: 'function',
				function: {
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				},
			}))
		}

		// Apply OpenRouter-specific options from middleware
		const orOpts = request.openrouter
		if (orOpts) {
			if (orOpts.providers) {
				body.provider = orOpts.providers
			}
			if (orOpts.route) {
				body.route = orOpts.route
			}
			if (orOpts.transforms) {
				body.transforms = orOpts.transforms
			}
			if (orOpts.preset) {
				body.preset = orOpts.preset
			}
		}

		return {
			url: OPENROUTER_API_URL,
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body,
		}
	}

	private async mapMessage(msg: LLMMessage, context?: InferenceContext): Promise<OpenRouterMessage> {
		const mapped = await this.mapMessageContent(msg, context)
		if (msg.cacheControl) {
			applyCacheControlToLastBlock(mapped)
		}
		return mapped
	}

	private async mapMessageContent(msg: LLMMessage, context?: InferenceContext): Promise<OpenRouterMessage> {
		switch (msg.role) {
			case 'tool': {
				const resolvedContent = await this.imageProcessor.resolveContent(msg.content, context?.fileStore)
				if (msg.isError) {
					const errorText = typeof resolvedContent === 'string' ? resolvedContent : JSON.stringify(resolvedContent)
					return {
						role: 'tool',
						content: `[ERROR] ${errorText}`,
						tool_call_id: msg.toolCallId,
					}
				}
				return {
					role: 'tool',
					content: this.mapContentToOpenRouter(resolvedContent),
					tool_call_id: msg.toolCallId,
				}
			}
			case 'assistant':
				if (msg.toolCalls?.length) {
					return {
						role: 'assistant',
						content: msg.content,
						tool_calls: msg.toolCalls.map((tc): OpenRouterToolCall => ({
							id: tc.id,
							type: 'function',
							function: { name: tc.name, arguments: JSON.stringify(tc.input) },
						})),
					}
				}
				return { role: 'assistant', content: msg.content }
			case 'system':
				return { role: 'system', content: msg.content }
			case 'user':
				if (Array.isArray(msg.content)) {
					const resolved = await this.imageProcessor.resolveContent(msg.content, context?.fileStore)
					return { role: 'user', content: this.mapContentToOpenRouter(resolved) }
				}
				return { role: 'user', content: msg.content }
		}
	}

	/**
	 * Map internal ChatMessageContentItem[] (camelCase imageUrl) to OpenRouter format (snake_case image_url).
	 */
	private mapContentToOpenRouter(content: string | ChatMessageContentItem[]): string | OpenRouterContentItem[] {
		if (typeof content === 'string') return content
		return content.map((item): OpenRouterContentItem => {
			if (item.type === 'text') {
				return { type: 'text', text: item.text }
			}
			if (item.type === 'image_url') {
				return { type: 'image_url', image_url: { url: item.imageUrl.url, detail: item.imageUrl.detail } }
			}
			return { type: 'text', text: JSON.stringify(item) }
		})
	}

	private extractContent(content: string | null | Array<unknown>): string | null {
		if (content === null || content === undefined) return null
		if (typeof content === 'string') return content
		if (Array.isArray(content)) {
			return content
				.filter((item): item is { type: 'text'; text: string } => typeof item === 'object' && item !== null && 'type' in item && item.type === 'text')
				.map((item) => item.text)
				.join('')
		}
		return null
	}

	private parseToolArguments(args: string): unknown {
		try {
			return JSON.parse(args)
		} catch {
			this.logger?.warn('Malformed JSON in tool call arguments', { rawArgs: args })
			return { raw: args }
		}
	}

	private mapFinishReason(reason: string | null): InferenceResponse['finishReason'] {
		switch (reason) {
			case 'stop':
				return 'stop'
			case 'tool_calls':
				return 'tool_calls'
			case 'length':
				return 'length'
			case 'error':
				return 'error'
			default:
				return 'stop'
		}
	}

	private mapHttpError(status: number, body: string): LLMError {
		let message = `HTTP ${status}`
		try {
			const parsed = JSON.parse(body) as OpenRouterErrorResponse
			if (parsed.error?.message) {
				message = parsed.error.message
			}
		} catch {
			if (body) message = body
		}

		if (status === 429) {
			return { type: 'rate_limit', message, retryAfterMs: 60000, statusCode: status, responseBody: body }
		}
		if (status === 400) {
			if (message.includes('context_length') || message.includes('maximum context')) {
				return { type: 'context_length', message, statusCode: status, responseBody: body }
			}
			return { type: 'invalid_request', message, statusCode: status, responseBody: body }
		}
		if (status >= 500) {
			return { type: 'server_error', message, statusCode: status, responseBody: body }
		}
		return { type: 'server_error', message, statusCode: status, responseBody: body }
	}

	private mapError(err: unknown): LLMError {
		if (err instanceof Error && err.name === 'AbortError') {
			return { type: 'aborted', message: 'Request was aborted' }
		}
		if (err instanceof TypeError && (err.message.includes('fetch') || err.message.includes('network'))) {
			return { type: 'network_error', message: err.message, cause: err }
		}
		return { type: 'network_error', message: err instanceof Error ? err.message : String(err), cause: err }
	}
}
