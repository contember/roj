import { describe, expect, test } from 'bun:test'
import type { LLMMessage } from '~/core/agents/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { applyCacheBreakpoint } from './cache-breakpoints.js'
import { OpenRouterProvider } from './openrouter.js'
import type { RawInferenceRequest } from './provider.js'
import { ModelId } from './schema.js'

// ============================================================================
// End-to-end buildHttpRequest with cache breakpoints
// ============================================================================
//
// Mirrors anthropic.test.ts cache placement coverage for OpenRouter, verifying
// that `cacheControl` on an LLMMessage translates to `cache_control` on the
// LAST block of the mapped output — regardless of block type.

const createProvider = () =>
	new OpenRouterProvider({
		apiKey: 'test-key',
		imageProcessor: { resolveContent: async (content) => content },
		defaultModel: 'anthropic/claude-haiku-4.5',
	})

type AnyBlock = { type: string; cache_control?: { type: 'ephemeral' }; [key: string]: unknown }
type OpenRouterMessage = {
	role: string
	content: string | AnyBlock[]
	tool_calls?: unknown
	tool_call_id?: string
}

const testModel = ModelId('anthropic/claude-haiku-4.5')

const buildRequest = (messages: LLMMessage[]): RawInferenceRequest => ({
	model: testModel,
	systemPrompt: 'You are helpful.',
	messages,
})

const getBodyMessages = (body: unknown): OpenRouterMessage[] => {
	const b = body as { messages: OpenRouterMessage[] }
	return b.messages
}

const asBlocks = (content: string | AnyBlock[]): AnyBlock[] => {
	if (typeof content === 'string') throw new Error('expected block array, got string')
	return content
}

describe('OpenRouterProvider buildHttpRequest cache placement', () => {
	test('pure tool_result target: cache_control lands on the tool role message content', async () => {
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

		// OpenRouter keeps the tool role as-is (doesn't merge like anthropic)
		const last = msgs[msgs.length - 1]
		expect(last.role).toBe('tool')
		// String content got wrapped into [{text, cache_control}] by applyCacheControlToLastBlock
		const blocks = asBlocks(last.content)
		expect(blocks).toHaveLength(1)
		expect(blocks[0].type).toBe('text')
		expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' })
	})

	test('assistant [text, tool_use, tool_use] target: cache_control on the last tool_call content block', async () => {
		// OpenRouter assistant messages put tool calls in a SEPARATE `tool_calls` field
		// rather than as content blocks — so for assistant the cache checkpoint lands
		// on the (text) content block, which is what OpenRouter's cache expects for
		// checkpoint + tool_calls.
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
		expect(assistant.tool_calls).toBeDefined()
		// String content got wrapped so cache_control has a place to live
		const blocks = asBlocks(assistant.content)
		expect(blocks).toHaveLength(1)
		expect(blocks[0].type).toBe('text')
		expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' })
	})

	test('ephemeral suffix: breakpoint at idx-1 (tool_result), ephemeral user comes after uncached', async () => {
		const history: LLMMessage[] = [
			{ role: 'user', content: 'Initial question' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: ToolCallId('call_1'), name: 'get_weather', input: { city: 'Prague' } }],
			},
			{ role: 'tool', toolCallId: ToolCallId('call_1'), content: 'Sunny' },
			{ role: 'user', content: '<session-context>plugin status</session-context>' },
		]
		const messages = applyCacheBreakpoint(history, 1)

		const http = await createProvider().buildHttpRequest(buildRequest(messages))
		const msgs = getBodyMessages(http.body)

		// The tool message (idx-1) is the breakpoint target
		const toolMsg = msgs.find((m) => m.role === 'tool')
		expect(toolMsg).toBeDefined()
		const toolBlocks = asBlocks(toolMsg!.content)
		expect(toolBlocks[toolBlocks.length - 1].cache_control).toEqual({ type: 'ephemeral' })

		// The last message is the ephemeral user — no cache_control
		const last = msgs[msgs.length - 1]
		expect(last.role).toBe('user')
		// Without flag, user content stays as plain string (no block wrap, no cache_control)
		expect(last.content).toBe('<session-context>plugin status</session-context>')
	})

	test('no flag on any message: only system has cache_control', async () => {
		const http = await createProvider().buildHttpRequest(buildRequest([
			{ role: 'user', content: 'What is 2+2?' },
			{ role: 'assistant', content: '4' },
			{ role: 'user', content: 'And 3+3?' },
		]))
		const msgs = getBodyMessages(http.body)

		// system is the first message in OpenRouter body
		const system = msgs[0]
		expect(system.role).toBe('system')
		const systemBlocks = asBlocks(system.content)
		expect(systemBlocks[0].cache_control).toEqual({ type: 'ephemeral' })

		// All other messages: plain string content, no cache_control anywhere
		for (const msg of msgs.slice(1)) {
			expect(typeof msg.content).toBe('string')
		}
	})
})
