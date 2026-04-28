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
	RawToolSpec,
} from './provider.js'
import type { RoutableLLMProvider } from './routing-provider.js'

// ============================================================================
// Configuration
// ============================================================================

export interface AnthropicConfig {
	apiKey: string
	defaultModel?: string
	timeout?: number
	logger?: Logger
	imageProcessor: ImageProcessor
	/** When set, enables extended thinking with this token budget. Min 1024. */
	thinkingBudget?: number
	/** Custom fetch function (for testing/caching). Defaults to globalThis.fetch. */
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

// ============================================================================
// Anthropic API types
// ============================================================================

interface AnthropicTextBlock {
	type: 'text'
	text: string
}

interface AnthropicThinkingBlock {
	type: 'thinking'
	thinking: string
}

interface AnthropicToolUseBlock {
	type: 'tool_use'
	id: string
	name: string
	input: unknown
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicThinkingBlock | AnthropicToolUseBlock

interface AnthropicMessageResponse {
	id: string
	type: 'message'
	role: 'assistant'
	content: AnthropicContentBlock[]
	model: string
	stop_reason: string | null
	usage: {
		input_tokens: number
		output_tokens: number
		cache_creation_input_tokens?: number
		cache_read_input_tokens?: number
	}
}

interface AnthropicErrorResponse {
	type: 'error'
	error: {
		type: string
		message: string
	}
}

// ============================================================================
// Request body types
// ============================================================================

interface AnthropicTextBlockParam {
	type: 'text'
	text: string
	cache_control?: { type: 'ephemeral' }
}

interface AnthropicImageBlockParam {
	type: 'image'
	source:
		| { type: 'base64'; media_type: string; data: string }
		| { type: 'url'; url: string }
	cache_control?: { type: 'ephemeral' }
}

interface AnthropicToolUseBlockParam {
	type: 'tool_use'
	id: string
	name: string
	input: unknown
	cache_control?: { type: 'ephemeral' }
}

interface AnthropicToolResultBlockParam {
	type: 'tool_result'
	tool_use_id: string
	content: string | Array<AnthropicTextBlockParam | AnthropicImageBlockParam>
	is_error?: boolean
	cache_control?: { type: 'ephemeral' }
}

type AnthropicContentBlockParam =
	| AnthropicTextBlockParam
	| AnthropicImageBlockParam
	| AnthropicToolUseBlockParam
	| AnthropicToolResultBlockParam

interface AnthropicMessageParam {
	role: 'user' | 'assistant'
	content: string | AnthropicContentBlockParam[]
}

/**
 * Add `cache_control: { type: 'ephemeral' }` to the LAST content block of an
 * AnthropicMessageParam, regardless of block type. Converts string content to
 * a single text block first so the mark has a place to live. Mutates in place
 * so the cache breakpoint survives subsequent `mergeConsecutiveMessages`.
 */
function applyCacheControlToLastBlock(msg: AnthropicMessageParam): void {
	if (typeof msg.content === 'string') {
		msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }]
		return
	}
	if (msg.content.length === 0) return
	const lastIdx = msg.content.length - 1
	msg.content[lastIdx] = { ...msg.content[lastIdx], cache_control: { type: 'ephemeral' } }
}

interface AnthropicToolParam {
	name: string
	description: string
	input_schema: Record<string, unknown>
}

interface AnthropicRequestBody {
	model: string
	max_tokens: number
	system: AnthropicTextBlockParam[]
	messages: AnthropicMessageParam[]
	stream: false
	tools?: AnthropicToolParam[]
	temperature?: number
	stop_sequences?: string[]
	thinking?: { type: 'enabled'; budget_tokens: number }
}

// ============================================================================
// AnthropicProvider
// ============================================================================

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

/** Anthropic model prefix used by OpenRouter */
const ANTHROPIC_PREFIX = 'anthropic/'

/** Known Anthropic model prefixes (without vendor prefix) */
const ANTHROPIC_MODEL_PREFIXES = ['claude-']

/** Per-million-token pricing: [input, output] */
const ANTHROPIC_PRICING: Record<string, [input: number, output: number]> = {
	'haiku': [1.00, 5.00],
	'sonnet': [3.00, 15.00],
	'opus': [5.00, 25.00],
}
/** Cache read = 10% of input price, cache write (5min ephemeral) = 125% of input price */
const CACHE_READ_MULTIPLIER = 0.1
const CACHE_WRITE_MULTIPLIER = 1.25

export class AnthropicProvider implements RoutableLLMProvider {
	readonly name = 'anthropic'
	private apiKey: string
	private defaultModel: string
	private logger?: Logger
	private imageProcessor: ImageProcessor
	private thinkingBudget?: number
	private timeout: number
	private fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>

	constructor(config: AnthropicConfig) {
		this.apiKey = config.apiKey
		this.defaultModel = config.defaultModel ?? 'claude-sonnet-4-5-20250514'
		this.logger = config.logger
		this.imageProcessor = config.imageProcessor
		this.thinkingBudget = config.thinkingBudget
		this.timeout = config.timeout ?? 120000
		this.fetchFn = config.fetch ?? globalThis.fetch
	}

	/**
	 * Returns true for models with `anthropic/` prefix or starting with `claude-`.
	 */
	canHandle(model: string): boolean {
		if (model.startsWith(ANTHROPIC_PREFIX)) return true
		return ANTHROPIC_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))
	}

	/**
	 * Normalizes model ID for the Anthropic API:
	 * 1. Strips `anthropic/` prefix if present
	 * 2. Converts version dots to dashes (OpenRouter `claude-opus-4.6` → Anthropic `claude-opus-4-6`)
	 */
	normalizeModel(model: string): string {
		let normalized = model.startsWith(ANTHROPIC_PREFIX)
			? model.slice(ANTHROPIC_PREFIX.length)
			: model
		// OpenRouter uses dots in version (claude-opus-4.6), Anthropic API uses dashes (claude-opus-4-6)
		normalized = normalized.replace(/(\d+)\.(\d+)/g, '$1-$2')
		return normalized
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

			// Combine with external signal if provided
			if (context?.signal) {
				context.signal.addEventListener('abort', () => controller.abort(), { once: true })
			}

			let response: Response
			try {
				response = await this.fetchFn(httpRequest.url, {
					method: httpRequest.method,
					headers: {
						...httpRequest.headers,
						'x-api-key': this.apiKey,
						'anthropic-dangerous-direct-browser-access': 'true',
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

			const data = await response.json() as AnthropicMessageResponse
			const latencyMs = Date.now() - startTime

			const textContent = data.content
				.filter((block): block is AnthropicTextBlock => block.type === 'text')
				.map((block) => block.text)
				.join('')

			const reasoning = data.content
				.filter((block): block is AnthropicThinkingBlock => block.type === 'thinking')
				.map((block) => block.thinking)
				.join('')

			const toolCalls: ToolCall[] = data.content
				.filter((block): block is AnthropicToolUseBlock => block.type === 'tool_use')
				.map((block) => ({
					id: ToolCallId(block.id),
					name: block.name,
					input: block.input,
				}))

			const metrics: LLMMetrics = {
				promptTokens: data.usage.input_tokens,
				completionTokens: data.usage.output_tokens,
				totalTokens: data.usage.input_tokens + data.usage.output_tokens,
				latencyMs,
				model: data.model,
				provider: this.name,
				cost: this.calculateCost(data.model, data.usage),
				cachedTokens: data.usage.cache_read_input_tokens || undefined,
				cacheWriteTokens: data.usage.cache_creation_input_tokens || undefined,
			}

			return Ok({
				content: textContent || null,
				toolCalls,
				finishReason: this.mapStopReason(data.stop_reason),
				metrics,
				providerRequestId: data.id,
				reasoning: reasoning || undefined,
			})
		} catch (error) {
			return Err(this.mapError(error))
		}
	}

	async buildHttpRequest(request: RawInferenceRequest, context?: InferenceContext): Promise<ProviderHttpRequest> {
		const mappedMessages = await Promise.all(request.messages.map((m) => this.mapMessage(m, context)))
		const mergedMessages = this.mergeConsecutiveMessages(mappedMessages)

		const body: AnthropicRequestBody = {
			model: request.model ?? this.defaultModel,
			max_tokens: request.maxTokens ?? 100_000,
			system: [{ type: 'text', text: request.systemPrompt, cache_control: { type: 'ephemeral' } }],
			messages: mergedMessages,
			stream: false,
		}

		if (request.tools?.length) {
			body.tools = request.tools.map((t): AnthropicToolParam => ({
				name: t.name,
				description: t.description,
				input_schema: t.parameters as AnthropicToolParam['input_schema'],
			}))
		}

		if (request.temperature !== undefined) {
			body.temperature = request.temperature
		}

		if (request.stopSequences?.length) {
			body.stop_sequences = request.stopSequences
		}

		const thinkingBudget = request.anthropic?.thinkingBudget ?? this.thinkingBudget
		if (thinkingBudget) {
			body.thinking = { type: 'enabled', budget_tokens: thinkingBudget }
		}

		return {
			url: ANTHROPIC_API_URL,
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'anthropic-version': ANTHROPIC_VERSION,
			},
			body,
		}
	}

	// ============================================================================
	// Message mapping
	// ============================================================================

	private async mapMessage(msg: LLMMessage, context?: InferenceContext): Promise<AnthropicMessageParam> {
		const mapped = await this.mapMessageContent(msg, context)
		if (msg.cacheControl) {
			applyCacheControlToLastBlock(mapped)
		}
		return mapped
	}

	private async mapMessageContent(msg: LLMMessage, context?: InferenceContext): Promise<AnthropicMessageParam> {
		switch (msg.role) {
			case 'tool': {
				const resolvedContent = await this.imageProcessor.resolveContent(msg.content, context?.fileStore)
				const toolResult = this.mapToolResultContent(resolvedContent, msg.isError)
				toolResult.tool_use_id = msg.toolCallId
				return {
					role: 'user',
					content: [toolResult],
				}
			}
			case 'assistant': {
				const contentBlocks: AnthropicContentBlockParam[] = []
				if (msg.content) {
					contentBlocks.push({ type: 'text', text: msg.content })
				}
				if (msg.toolCalls?.length) {
					for (const tc of msg.toolCalls) {
						contentBlocks.push({
							type: 'tool_use',
							id: tc.id,
							name: tc.name,
							input: tc.input as Record<string, unknown>,
						})
					}
				}
				return {
					role: 'assistant',
					content: contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }],
				}
			}
			case 'system':
				return {
					role: 'user',
					content: [{ type: 'text', text: `[System] ${msg.content}` }],
				}
			case 'user': {
				if (Array.isArray(msg.content)) {
					const resolved = await this.imageProcessor.resolveContent(msg.content, context?.fileStore)
					const blocks = this.mapUserContentItems(Array.isArray(resolved) ? resolved : [{ type: 'text', text: String(resolved) }])
					return { role: 'user', content: blocks }
				}
				return { role: 'user', content: msg.content }
			}
		}
	}

	private mapToolResultContent(content: string | ChatMessageContentItem[], isError?: boolean): AnthropicToolResultBlockParam {
		if (typeof content === 'string') {
			const text = isError ? `[ERROR] ${content}` : content
			return {
				type: 'tool_result',
				tool_use_id: '', // will be set by caller context — but we set it in mapMessage
				content: text,
			}
		}

		const blocks = this.mapUserContentItems(content)
		return {
			type: 'tool_result',
			tool_use_id: '',
			content: blocks,
			is_error: isError,
		}
	}

	private mapUserContentItems(items: ChatMessageContentItem[]): Array<AnthropicTextBlockParam | AnthropicImageBlockParam> {
		return items.map((item) => {
			if (item.type === 'text') {
				return { type: 'text' as const, text: item.text }
			}
			if (item.type === 'image_url') {
				return this.mapImageContent(item.imageUrl.url)
			}
			return { type: 'text' as const, text: JSON.stringify(item) }
		})
	}

	private mapImageContent(url: string): AnthropicImageBlockParam {
		const dataUrlMatch = url.match(/^data:(image\/[^;]+);base64,(.+)$/)
		if (dataUrlMatch) {
			return {
				type: 'image',
				source: {
					type: 'base64',
					media_type: dataUrlMatch[1],
					data: dataUrlMatch[2],
				},
			}
		}
		return {
			type: 'image',
			source: {
				type: 'url',
				url,
			},
		}
	}

	// ============================================================================
	// Message alternation
	// ============================================================================

	private mergeConsecutiveMessages(messages: AnthropicMessageParam[]): AnthropicMessageParam[] {
		if (messages.length === 0) return []

		const result: AnthropicMessageParam[] = []
		for (const msg of messages) {
			const last = result[result.length - 1]
			if (last && last.role === msg.role) {
				// Merge content arrays
				const lastContent = this.normalizeContent(last.content)
				const msgContent = this.normalizeContent(msg.content)
				last.content = [...lastContent, ...msgContent]
			} else {
				result.push({ ...msg, content: this.normalizeContent(msg.content) })
			}
		}
		return result
	}

	private normalizeContent(content: AnthropicMessageParam['content']): AnthropicContentBlockParam[] {
		if (typeof content === 'string') {
			return [{ type: 'text', text: content }]
		}
		return [...content]
	}

	// ============================================================================
	// Response mapping
	// ============================================================================

	private mapStopReason(reason: string | null): InferenceResponse['finishReason'] {
		switch (reason) {
			case 'end_turn':
				return 'stop'
			case 'tool_use':
				return 'tool_calls'
			case 'max_tokens':
				return 'length'
			default:
				return 'stop'
		}
	}

	// ============================================================================
	// Cost calculation
	// ============================================================================

	private calculateCost(model: string, usage: AnthropicMessageResponse['usage']): number | undefined {
		const family = Object.keys(ANTHROPIC_PRICING).find((key) => model.includes(key))
		if (!family) return undefined
		const [inputPrice, outputPrice] = ANTHROPIC_PRICING[family]
		const perM = 1_000_000
		const inputCost = usage.input_tokens * inputPrice / perM
		const outputCost = usage.output_tokens * outputPrice / perM
		const cacheReadCost = (usage.cache_read_input_tokens ?? 0) * inputPrice * CACHE_READ_MULTIPLIER / perM
		const cacheWriteCost = (usage.cache_creation_input_tokens ?? 0) * inputPrice * CACHE_WRITE_MULTIPLIER / perM
		return inputCost + outputCost + cacheReadCost + cacheWriteCost
	}

	// ============================================================================
	// Error mapping
	// ============================================================================

	private mapHttpError(status: number, body: string): LLMError {
		let message = `HTTP ${status}`
		try {
			const parsed = JSON.parse(body) as AnthropicErrorResponse
			if (parsed.error?.message) {
				message = parsed.error.message
			}
		} catch {
			// use raw body as message if not parseable
			if (body) message = body
		}

		if (status === 429) {
			return { type: 'rate_limit', message, retryAfterMs: 60000, statusCode: status }
		}
		if (status === 400) {
			if (message.includes('max_tokens') || message.includes('too long') || message.includes('context') || message.includes('token')) {
				return { type: 'context_length', message, statusCode: status }
			}
			return { type: 'invalid_request', message, statusCode: status }
		}
		if (status === 401) {
			return { type: 'invalid_request', message, statusCode: status }
		}
		if (status === 529 || status >= 500) {
			return { type: 'server_error', message, statusCode: status }
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
