import { describe, expect, test } from 'bun:test'
import type { LLMMessage } from '~/core/agents/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import type { LogContext, Logger } from '~/lib/logger/logger.js'
import { AnthropicProvider } from './anthropic.js'
import { sanitizeProviderMessages } from './message-sanitization.js'
import { OpenRouterProvider } from './openrouter.js'
import type { RawInferenceRequest } from './provider.js'
import { ModelId } from './schema.js'

type CapturedWarning = {
	message: string
	context?: LogContext
}

const createCapturingLogger = (): { logger: Logger; warnings: CapturedWarning[] } => {
	const warnings: CapturedWarning[] = []
	const logger: Logger = {
		debug: () => {},
		info: () => {},
		warn: (message, context) => warnings.push({ message, context }),
		error: () => {},
		child: () => logger,
		level: 'debug',
	}
	return { logger, warnings }
}

const createOpenRouterProvider = (logger?: Logger) =>
	new OpenRouterProvider({
		apiKey: 'test-key',
		imageProcessor: { resolveContent: async (content) => content },
		logger,
	})

const createAnthropicProvider = (logger?: Logger) =>
	new AnthropicProvider({
		apiKey: 'test-key',
		imageProcessor: { resolveContent: async (content) => content },
		logger,
	})

const buildRequest = (messages: LLMMessage[]): RawInferenceRequest => ({
	model: ModelId('test-model'),
	systemPrompt: 'You are helpful.',
	messages,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null

const getBodyMessages = (body: unknown): Record<string, unknown>[] => {
	if (!isRecord(body) || !Array.isArray(body.messages)) {
		throw new Error('Expected a request body with messages')
	}
	return body.messages.map((message) => {
		if (!isRecord(message)) {
			throw new Error('Expected each request message to be an object')
		}
		return message
	})
}

const getContentBlocks = (message: Record<string, unknown>): Record<string, unknown>[] => {
	if (!Array.isArray(message.content)) {
		throw new Error('Expected message content blocks')
	}
	return message.content.map((block) => {
		if (!isRecord(block)) {
			throw new Error('Expected each content block to be an object')
		}
		return block
	})
}

const wellFormedToolHistory = (): LLMMessage[] => [
	{ role: 'user', content: 'Check the weather' },
	{
		role: 'assistant',
		content: '',
		toolCalls: [{ id: ToolCallId('call_1'), name: 'get_weather', input: { city: 'Prague' } }],
	},
	{
		role: 'tool',
		toolCallId: ToolCallId('call_1'),
		toolName: 'get_weather',
		content: 'Sunny',
	},
]

const orphanedToolHistory = (): LLMMessage[] => [
	{ role: 'user', content: 'Check the weather' },
	{ role: 'assistant', content: 'I will check.' },
	{
		role: 'tool',
		toolCallId: ToolCallId('orphan_1'),
		toolName: 'get_weather',
		content: 'Sunny',
		cacheControl: { type: 'ephemeral' },
	},
]

describe('sanitizeProviderMessages', () => {
	test('returns a well-formed history unchanged', () => {
		const messages = wellFormedToolHistory()
		const result = sanitizeProviderMessages(messages, 'test')

		expect(result).toBe(messages)
		expect(result).toEqual(messages)
	})

	test('preserves an orphaned tool result as a marked user message and warns', () => {
		const { logger, warnings } = createCapturingLogger()
		const result = sanitizeProviderMessages(orphanedToolHistory(), 'test', logger)

		expect(result[result.length - 1]).toEqual({
			role: 'user',
			content: '[Orphaned tool result from "get_weather"; tool call ID: orphan_1]\nSunny',
			cacheControl: { type: 'ephemeral' },
		})
		expect(warnings).toEqual([{
			message: 'Orphaned tool result converted to user message',
			context: {
				provider: 'test',
				messageIndex: 2,
				toolCallId: 'orphan_1',
				toolName: 'get_weather',
			},
		}])
	})

	test('rejects a history ending in an assistant message', () => {
		expect(() => sanitizeProviderMessages([
			{ role: 'user', content: 'Hello' },
			{ role: 'assistant', content: 'Hello back' },
		], 'test')).toThrow('test request history ends with an assistant message after sanitation')
	})
})

describe('OpenRouterProvider message sanitation', () => {
	test('converts a trailing orphan to user without moving its cache breakpoint', async () => {
		const { logger, warnings } = createCapturingLogger()
		const request = await createOpenRouterProvider(logger).buildHttpRequest(buildRequest(orphanedToolHistory()))
		const messages = getBodyMessages(request.body)
		const last = messages[messages.length - 1]
		const blocks = getContentBlocks(last)

		expect(last.role).toBe('user')
		expect(blocks).toEqual([{
			type: 'text',
			text: '[Orphaned tool result from "get_weather"; tool call ID: orphan_1]\nSunny',
			cache_control: { type: 'ephemeral' },
		}])
		expect(warnings).toHaveLength(1)
	})

	test('keeps a matched tool result as a tool message', async () => {
		const request = await createOpenRouterProvider().buildHttpRequest(buildRequest(wellFormedToolHistory()))
		const messages = getBodyMessages(request.body)
		const last = messages[messages.length - 1]

		expect(last).toEqual({
			role: 'tool',
			content: 'Sunny',
			tool_call_id: 'call_1',
		})
	})

	test('rejects an assistant tail before issuing a request', async () => {
		const promise = createOpenRouterProvider().buildHttpRequest(buildRequest([
			{ role: 'user', content: 'Hello' },
			{ role: 'assistant', content: 'Hello back' },
		]))

		await expect(promise).rejects.toThrow('openrouter request history ends with an assistant message after sanitation')
	})
})

describe('AnthropicProvider message sanitation', () => {
	test('converts a trailing orphan to user without moving its cache breakpoint', async () => {
		const { logger, warnings } = createCapturingLogger()
		const request = await createAnthropicProvider(logger).buildHttpRequest(buildRequest(orphanedToolHistory()))
		const messages = getBodyMessages(request.body)
		const last = messages[messages.length - 1]
		const blocks = getContentBlocks(last)

		expect(last.role).toBe('user')
		expect(blocks).toEqual([{
			type: 'text',
			text: '[Orphaned tool result from "get_weather"; tool call ID: orphan_1]\nSunny',
			cache_control: { type: 'ephemeral' },
		}])
		expect(warnings).toHaveLength(1)
	})

	test('keeps a matched tool result as a tool_result block', async () => {
		const request = await createAnthropicProvider().buildHttpRequest(buildRequest(wellFormedToolHistory()))
		const messages = getBodyMessages(request.body)
		const last = messages[messages.length - 1]

		expect(last.role).toBe('user')
		expect(getContentBlocks(last)).toEqual([{
			type: 'tool_result',
			tool_use_id: 'call_1',
			content: 'Sunny',
		}])
	})

	test('rejects an assistant tail before issuing a request', async () => {
		const promise = createAnthropicProvider().buildHttpRequest(buildRequest([
			{ role: 'user', content: 'Hello' },
			{ role: 'assistant', content: 'Hello back' },
		]))

		await expect(promise).rejects.toThrow('anthropic request history ends with an assistant message after sanitation')
	})
})
