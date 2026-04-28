import { describe, expect, test } from 'bun:test'
import type { LLMMessage } from '~/core/agents/state.js'
import { ModelId } from '~/core/llm/schema.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { AnthropicProvider } from './anthropic.js'
import { applyCacheBreakpoint } from './cache-breakpoints.js'
import type { RawInferenceRequest } from './provider.js'

// ============================================================================
// Helpers — access private methods via prototype for testing
// ============================================================================

const createProvider = () =>
	new AnthropicProvider({
		apiKey: 'test-key',
		imageProcessor: {
			resolveContent: async (content) => content,
		},
	})

// Access private methods for unit testing the mapping logic
const provider = createProvider()
const mapMessage = (provider as any).mapMessage.bind(provider) as (msg: LLMMessage) => Promise<{ role: string; content: unknown }>
const mergeConsecutiveMessages = (provider as any).mergeConsecutiveMessages.bind(provider) as (
	msgs: { role: string; content: unknown }[],
) => { role: string; content: unknown }[]
const mapStopReason = (provider as any).mapStopReason.bind(provider) as (reason: string | null) => string
const mapError = (provider as any).mapError.bind(provider) as (err: unknown) => unknown

// ============================================================================
// Message Mapping
// ============================================================================

describe('AnthropicProvider message mapping', () => {
	test('maps user message with string content', async () => {
		const result = await mapMessage({ role: 'user', content: 'Hello' })
		expect(result).toEqual({ role: 'user', content: 'Hello' })
	})

	test('maps user message with multimodal content', async () => {
		const result = await mapMessage({
			role: 'user',
			content: [
				{ type: 'text', text: 'Look at this image' },
				{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,abc123' } },
			],
		})
		expect(result).toEqual({
			role: 'user',
			content: [
				{ type: 'text', text: 'Look at this image' },
				{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
			],
		})
	})

	test('maps user message with HTTP image URL', async () => {
		const result = await mapMessage({
			role: 'user',
			content: [
				{ type: 'image_url', imageUrl: { url: 'https://example.com/img.jpg' } },
			],
		})
		expect(result).toEqual({
			role: 'user',
			content: [
				{ type: 'image', source: { type: 'url', url: 'https://example.com/img.jpg' } },
			],
		})
	})

	test('maps assistant message with content only', async () => {
		const result = await mapMessage({ role: 'assistant', content: 'Hello back' })
		expect(result).toEqual({
			role: 'assistant',
			content: [{ type: 'text', text: 'Hello back' }],
		})
	})

	test('maps assistant message with tool calls', async () => {
		const result = await mapMessage({
			role: 'assistant',
			content: 'Let me help',
			toolCalls: [{ id: ToolCallId('tc_1'), name: 'search', input: { query: 'test' } }],
		})
		expect(result).toEqual({
			role: 'assistant',
			content: [
				{ type: 'text', text: 'Let me help' },
				{ type: 'tool_use', id: 'tc_1', name: 'search', input: { query: 'test' } },
			],
		})
	})

	test('maps assistant message with empty content and tool calls', async () => {
		const result = await mapMessage({
			role: 'assistant',
			content: '',
			toolCalls: [{ id: ToolCallId('tc_1'), name: 'search', input: { query: 'test' } }],
		})
		expect(result).toEqual({
			role: 'assistant',
			content: [
				{ type: 'tool_use', id: 'tc_1', name: 'search', input: { query: 'test' } },
			],
		})
	})

	test('maps tool result to user role with tool_result block', async () => {
		const result = await mapMessage({
			role: 'tool',
			content: 'result data',
			toolCallId: ToolCallId('tc_1'),
		})
		expect(result).toEqual({
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'tc_1', content: 'result data' }],
		})
	})

	test('maps tool error result with ERROR prefix', async () => {
		const result = await mapMessage({
			role: 'tool',
			content: 'something failed',
			toolCallId: ToolCallId('tc_1'),
			isError: true,
		})
		expect(result).toEqual({
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'tc_1', content: '[ERROR] something failed' }],
		})
	})

	test('maps system message to user with [System] prefix', async () => {
		const result = await mapMessage({ role: 'system', content: 'Context information' })
		expect(result).toEqual({
			role: 'user',
			content: [{ type: 'text', text: '[System] Context information' }],
		})
	})
})

// ============================================================================
// Message Alternation
// ============================================================================

describe('AnthropicProvider message alternation', () => {
	test('merges consecutive user messages', () => {
		const messages = [
			{ role: 'user' as const, content: 'Hello' },
			{ role: 'user' as const, content: 'How are you?' },
		]
		const result = mergeConsecutiveMessages(messages)
		expect(result).toEqual([{
			role: 'user',
			content: [
				{ type: 'text', text: 'Hello' },
				{ type: 'text', text: 'How are you?' },
			],
		}])
	})

	test('merges consecutive user messages with mixed content types', () => {
		const messages = [
			{ role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'tc_1', content: 'result1' }] },
			{ role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'tc_2', content: 'result2' }] },
		]
		const result = mergeConsecutiveMessages(messages)
		expect(result).toHaveLength(1)
		expect(result[0].role).toBe('user')
		expect(Array.isArray(result[0].content)).toBe(true)
		expect((result[0].content as any[]).length).toBe(2)
	})

	test('does not merge messages with different roles', () => {
		const messages = [
			{ role: 'user' as const, content: 'Hello' },
			{ role: 'assistant' as const, content: 'Hi' },
			{ role: 'user' as const, content: 'How are you?' },
		]
		const result = mergeConsecutiveMessages(messages)
		expect(result).toHaveLength(3)
	})

	test('handles empty input', () => {
		expect(mergeConsecutiveMessages([])).toEqual([])
	})
})

// ============================================================================
// Cache Breakpoints
// ============================================================================

describe('applyCacheBreakpoint (shared helper)', () => {
	test('marks the last message when uncachedSuffixCount is 0', () => {
		const messages: LLMMessage[] = [
			{ role: 'user', content: 'Hello' },
			{ role: 'assistant', content: 'Hi' },
			{ role: 'user', content: 'Question' },
		]
		const result = applyCacheBreakpoint(messages, 0)
		expect(result[2].cacheControl).toEqual({ type: 'ephemeral' })
		expect(result[0].cacheControl).toBeUndefined()
		expect(result[1].cacheControl).toBeUndefined()
	})

	test('marks second-to-last when uncachedSuffixCount is 1', () => {
		const messages: LLMMessage[] = [
			{ role: 'user', content: 'Hello' },
			{ role: 'assistant', content: 'Hi' },
			{ role: 'user', content: 'Question' },
		]
		const result = applyCacheBreakpoint(messages, 1)
		expect(result[1].cacheControl).toEqual({ type: 'ephemeral' })
		expect(result[2].cacheControl).toBeUndefined()
	})

	test('no-op when suffix exceeds message count', () => {
		const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }]
		const result = applyCacheBreakpoint(messages, 5)
		expect(result[0].cacheControl).toBeUndefined()
	})
})

describe('AnthropicProvider cache breakpoint placement', () => {
	test('adds cache_control to last block of flagged user string message', async () => {
		const result = await mapMessage({
			role: 'user',
			content: 'Hello',
			cacheControl: { type: 'ephemeral' },
		})
		expect(Array.isArray(result.content)).toBe(true)
		const content = result.content as Array<{ type: string; cache_control?: unknown }>
		expect(content[content.length - 1].cache_control).toEqual({ type: 'ephemeral' })
	})

	test('adds cache_control to outer tool_result block (not inner content)', async () => {
		const result = await mapMessage({
			role: 'tool',
			content: 'result data',
			toolCallId: ToolCallId('tc_1'),
			cacheControl: { type: 'ephemeral' },
		})
		const content = result.content as Array<{ type: string; cache_control?: unknown }>
		expect(content).toHaveLength(1)
		expect(content[0].type).toBe('tool_result')
		expect(content[0].cache_control).toEqual({ type: 'ephemeral' })
	})

	test('adds cache_control to last block of assistant with text + tool_use', async () => {
		const result = await mapMessage({
			role: 'assistant',
			content: 'Let me help',
			toolCalls: [{ id: ToolCallId('tc_1'), name: 'search', input: { query: 'test' } }],
			cacheControl: { type: 'ephemeral' },
		})
		const content = result.content as Array<{ type: string; cache_control?: unknown }>
		// Last block is the tool_use — that's where cache_control must land
		expect(content[content.length - 1].type).toBe('tool_use')
		expect(content[content.length - 1].cache_control).toEqual({ type: 'ephemeral' })
	})

	test('no cache_control on messages without flag', async () => {
		const result = await mapMessage({ role: 'user', content: 'Hello' })
		expect(result).toEqual({ role: 'user', content: 'Hello' })
	})
})

// ============================================================================
// End-to-end buildHttpRequest with cache breakpoints
// ============================================================================
//
// Covers the bug scenarios that the old provider-level `applyCacheBreakpoints`
// silently no-op'd on: pure tool_result target, assistant with tool_use last,
// and the agent-side pipeline (applyCacheBreakpoint + mergeConsecutiveMessages).

type AnyBlock = { type: string; cache_control?: { type: 'ephemeral' }; [key: string]: unknown }
type AnthropicMessage = { role: string; content: AnyBlock[] }

const testModel = ModelId('claude-haiku-4-5-20251001')

const buildRequest = (messages: LLMMessage[]): RawInferenceRequest => ({
	model: testModel,
	systemPrompt: 'You are helpful.',
	messages,
})

const getBodyMessages = (body: unknown): AnthropicMessage[] => {
	const b = body as { messages: AnthropicMessage[] }
	return b.messages
}

describe('AnthropicProvider buildHttpRequest cache placement', () => {
	test('pure tool_result target: cache_control lands on outer tool_result block', async () => {
		const messages = applyCacheBreakpoint([
			{ role: 'user', content: 'What is the weather?' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: ToolCallId('call_1'), name: 'get_weather', input: { city: 'Prague' } }],
			},
			{ role: 'tool', toolCallId: ToolCallId('call_1'), content: 'Sunny, 22°C' },
		], 0)

		const http = await createProvider().buildHttpRequest(buildRequest(messages))
		const msgs = getBodyMessages(http.body)

		// Last message is the merged user containing the tool_result
		const last = msgs[msgs.length - 1]
		expect(last.role).toBe('user')
		expect(Array.isArray(last.content)).toBe(true)
		const lastBlock = last.content[last.content.length - 1]
		expect(lastBlock.type).toBe('tool_result')
		expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' })
	})

	test('consecutive tool_results merged: cache_control lands on LAST merged tool_result', async () => {
		const messages = applyCacheBreakpoint([
			{ role: 'user', content: 'Check two cities' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [
					{ id: ToolCallId('call_1'), name: 'get_weather', input: { city: 'Prague' } },
					{ id: ToolCallId('call_2'), name: 'get_weather', input: { city: 'London' } },
				],
			},
			{ role: 'tool', toolCallId: ToolCallId('call_1'), content: 'Sunny' },
			{ role: 'tool', toolCallId: ToolCallId('call_2'), content: 'Rainy' },
		], 0)

		const http = await createProvider().buildHttpRequest(buildRequest(messages))
		const msgs = getBodyMessages(http.body)

		const last = msgs[msgs.length - 1]
		expect(last.role).toBe('user')
		// Two tool_results merged into one user message
		expect(last.content.length).toBe(2)
		expect(last.content[0].type).toBe('tool_result')
		expect(last.content[1].type).toBe('tool_result')
		expect(last.content[0].cache_control).toBeUndefined()
		// cache_control is on the LAST tool_result (the target message's block after merge)
		expect(last.content[1].cache_control).toEqual({ type: 'ephemeral' })
	})

	test('assistant [text, tool_use, tool_use] target: cache_control lands on LAST tool_use', async () => {
		const messages = applyCacheBreakpoint([
			{ role: 'user', content: 'Check weather and search' },
			{
				role: 'assistant',
				content: 'Let me check both',
				toolCalls: [
					{ id: ToolCallId('call_1'), name: 'get_weather', input: { city: 'Prague' } },
					{ id: ToolCallId('call_2'), name: 'search', input: { query: 'weather' } },
				],
			},
		], 0)

		const http = await createProvider().buildHttpRequest(buildRequest(messages))
		const msgs = getBodyMessages(http.body)

		const assistant = msgs[msgs.length - 1]
		expect(assistant.role).toBe('assistant')
		expect(assistant.content.length).toBe(3) // text + 2 tool_use
		expect(assistant.content[0].type).toBe('text')
		expect(assistant.content[0].cache_control).toBeUndefined()
		expect(assistant.content[1].type).toBe('tool_use')
		expect(assistant.content[1].cache_control).toBeUndefined()
		// cache_control lands on the LAST block (last tool_use), not the first text block
		expect(assistant.content[2].type).toBe('tool_use')
		expect(assistant.content[2].cache_control).toEqual({ type: 'ephemeral' })
	})

	test('ephemeral suffix: breakpoint at idx-1, ephemeral user merges after as uncached suffix', async () => {
		const history: LLMMessage[] = [
			{ role: 'user', content: 'Initial question' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: ToolCallId('call_1'), name: 'get_weather', input: { city: 'Prague' } }],
			},
			{ role: 'tool', toolCallId: ToolCallId('call_1'), content: 'Sunny' },
			// simulate agent.ts pushing ephemeral session context last
			{ role: 'user', content: '<session-context>plugin status</session-context>' },
		]
		const messages = applyCacheBreakpoint(history, 1) // uncachedSuffixCount = 1 (ephemeral tail)

		const http = await createProvider().buildHttpRequest(buildRequest(messages))
		const msgs = getBodyMessages(http.body)

		// mergeConsecutiveMessages folds the tool_result and ephemeral into one user message
		const last = msgs[msgs.length - 1]
		expect(last.role).toBe('user')
		// Content: [tool_result (cached), text (ephemeral, uncached)]
		expect(last.content.length).toBe(2)
		expect(last.content[0].type).toBe('tool_result')
		expect(last.content[0].cache_control).toEqual({ type: 'ephemeral' })
		expect(last.content[1].type).toBe('text')
		// Ephemeral comes AFTER the cache checkpoint, so it's fresh each call
		expect(last.content[1].cache_control).toBeUndefined()
	})

	test('no flag on any message: only system prompt has cache_control', async () => {
		const http = await createProvider().buildHttpRequest(buildRequest([
			{ role: 'user', content: 'What is 2+2?' },
			{ role: 'assistant', content: '4' },
			{ role: 'user', content: 'And 3+3?' },
		]))
		const msgs = getBodyMessages(http.body)

		for (const msg of msgs) {
			for (const block of msg.content) {
				expect(block.cache_control).toBeUndefined()
			}
		}
		// System still has cache_control (hardcoded in provider)
		const system = (http.body as { system: AnyBlock[] }).system
		expect(system[0].cache_control).toEqual({ type: 'ephemeral' })
	})
})

// ============================================================================
// Stop Reason Mapping
// ============================================================================

describe('AnthropicProvider stop reason mapping', () => {
	test('maps end_turn to stop', () => {
		expect(mapStopReason('end_turn')).toBe('stop')
	})

	test('maps tool_use to tool_calls', () => {
		expect(mapStopReason('tool_use')).toBe('tool_calls')
	})

	test('maps max_tokens to length', () => {
		expect(mapStopReason('max_tokens')).toBe('length')
	})

	test('maps null to stop', () => {
		expect(mapStopReason(null)).toBe('stop')
	})

	test('maps unknown reason to stop', () => {
		expect(mapStopReason('something_new')).toBe('stop')
	})
})

// ============================================================================
// Error Mapping
// ============================================================================

describe('AnthropicProvider error mapping', () => {
	test('maps AbortError', () => {
		const err = new Error('aborted')
		err.name = 'AbortError'
		const result = mapError(err) as any
		expect(result.type).toBe('aborted')
	})

	test('maps unknown error to network_error', () => {
		const result = mapError(new Error('something')) as any
		expect(result.type).toBe('network_error')
		expect(result.message).toBe('something')
	})

	test('maps string error', () => {
		const result = mapError('boom') as any
		expect(result.type).toBe('network_error')
		expect(result.message).toBe('boom')
	})
})

// ============================================================================
// Model Routing (canHandle / normalizeModel)
// ============================================================================

describe('AnthropicProvider model routing', () => {
	test('handles anthropic/ prefixed models', () => {
		expect(provider.canHandle('anthropic/claude-sonnet-4.5')).toBe(true)
		expect(provider.canHandle('anthropic/claude-haiku-4.5')).toBe(true)
		expect(provider.canHandle('anthropic/claude-3.5-haiku')).toBe(true)
	})

	test('handles claude- prefixed models without vendor prefix', () => {
		expect(provider.canHandle('claude-sonnet-4-5-20250514')).toBe(true)
		expect(provider.canHandle('claude-3-5-haiku-20241022')).toBe(true)
	})

	test('does not handle non-Anthropic models', () => {
		expect(provider.canHandle('openai/gpt-4o')).toBe(false)
		expect(provider.canHandle('google/gemini-pro')).toBe(false)
		expect(provider.canHandle('meta-llama/llama-3')).toBe(false)
	})

	test('strips anthropic/ prefix and converts dots to dashes', () => {
		expect(provider.normalizeModel('anthropic/claude-opus-4.6')).toBe('claude-opus-4-6')
		expect(provider.normalizeModel('anthropic/claude-sonnet-4.5')).toBe('claude-sonnet-4-5')
		expect(provider.normalizeModel('anthropic/claude-haiku-4.5')).toBe('claude-haiku-4-5')
	})

	test('converts dots to dashes without prefix', () => {
		expect(provider.normalizeModel('claude-opus-4.6')).toBe('claude-opus-4-6')
	})

	test('keeps model ID as-is when already in Anthropic format', () => {
		expect(provider.normalizeModel('claude-sonnet-4-5-20250514')).toBe('claude-sonnet-4-5-20250514')
		expect(provider.normalizeModel('claude-opus-4-6')).toBe('claude-opus-4-6')
	})
})
