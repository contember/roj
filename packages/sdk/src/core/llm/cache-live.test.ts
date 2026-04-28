/**
 * Live cache verification tests for Anthropic + OpenRouter providers.
 *
 * Opt-in: run with `LIVE_TESTS=1 ANTHROPIC_API_KEY=… OPENROUTER_API_KEY=…`.
 * Skipped otherwise so the default `bun test` run stays hermetic.
 *
 * These tests bypass snapshot-fetch entirely (use real `globalThis.fetch`) so
 * two sequential identical calls actually land on the live API — proving that
 * the new message-level `cacheControl` flag → last-block placement is both
 * accepted and honored as a prompt cache checkpoint.
 *
 * The system prompt is padded to comfortably exceed Anthropic's 1024-token
 * minimum cacheable prefix for Haiku / Sonnet.
 */

import { describe, expect, test } from 'bun:test'
import z4 from 'zod/v4'
import type { LLMMessage } from '~/core/agents/state.js'
import type { ImageProcessor } from '~/core/image/types.js'
import type { ToolDefinition } from '~/core/tools/definition.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { AnthropicProvider } from './anthropic.js'
import { applyCacheBreakpoint } from './cache-breakpoints.js'
import { OpenRouterProvider } from './openrouter.js'
import { ModelId } from './schema.js'

const liveEnabled = process.env.LIVE_TESTS === '1'
const anthropicApiKey = liveEnabled ? process.env.ANTHROPIC_API_KEY : undefined
const openRouterApiKey = liveEnabled ? process.env.OPENROUTER_API_KEY : undefined

const noopImageProcessor: ImageProcessor = {
	resolveContent: async (content) => content,
}

const weatherTool: ToolDefinition<{ city: string }> = {
	name: 'get_weather',
	description: 'Get current weather for a city',
	input: z4.object({ city: z4.string() }),
	execute: async () => ({ ok: true, value: 'not implemented' }),
}

/**
 * Large filler system prompt to push the cacheable prefix comfortably past
 * Anthropic's 1024-token minimum. Content is deterministic so successive
 * calls reuse the exact same prefix.
 */
const LARGE_SYSTEM_PROMPT = [
	'You are a meticulous assistant helping with data analysis tasks.',
	'Always respond concisely and accurately. Never speculate beyond the data.',
	'When you use tools, interpret the results carefully and explain your reasoning.',
	'Follow these rules strictly:',
	...Array.from(
		{ length: 120 },
		(_, i) => `- Rule ${i + 1}: When asked about topic ${i + 1}, prefer factual sources and cite them when possible. Decline to speculate.`,
	),
	'End of instructions.',
].join('\n')

const describeLive = (name: string, apiKey: string | undefined, fn: () => void) => {
	if (!apiKey) {
		describe.skip(`${name} (skipped — API key missing)`, fn)
		return
	}
	describe(name, fn)
}

describeLive('Anthropic live cache verification', anthropicApiKey, () => {
	test('cacheControl on tool_result target causes cache write then cache read', async () => {
		const provider = new AnthropicProvider({
			apiKey: anthropicApiKey!,
			imageProcessor: noopImageProcessor,
			defaultModel: 'claude-haiku-4-5-20251001',
		})

		const history: LLMMessage[] = [
			{ role: 'user', content: 'What is the weather in Prague?' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: ToolCallId('call_1'), name: 'get_weather', input: { city: 'Prague' } }],
			},
			{
				role: 'tool',
				toolCallId: ToolCallId('call_1'),
				content: 'Sunny, 22°C, light breeze from the west.',
			},
		]
		const messages = applyCacheBreakpoint(history, 0)

		const request = {
			model: ModelId('claude-haiku-4-5-20251001'),
			systemPrompt: LARGE_SYSTEM_PROMPT,
			messages,
			tools: [weatherTool],
		}

		// First call — primes the cache
		const first = await provider.inference(request)
		if (!first.ok) {
			if (first.error.message?.includes('credit balance')) {
				console.warn('⚠️  Anthropic live cache test skipped: credit balance too low')
				return
			}
			throw new Error(`first call failed: ${JSON.stringify(first.error)}`)
		}
		expect(first.value.metrics.promptTokens).toBeGreaterThan(1024)

		// Second call — cache read proves the write on call 1 was honored
		const second = await provider.inference(request)
		if (!second.ok) throw new Error(`second call failed: ${JSON.stringify(second.error)}`)
		expect(second.value.metrics.cachedTokens ?? 0).toBeGreaterThan(1024)
	}, 60_000)
})

describeLive('OpenRouter live cache verification', openRouterApiKey, () => {
	test('cacheControl on tool_result target produces cache hit on second call', async () => {
		const provider = new OpenRouterProvider({
			apiKey: openRouterApiKey!,
			imageProcessor: noopImageProcessor,
			defaultModel: 'anthropic/claude-haiku-4.5',
		})

		const history: LLMMessage[] = [
			{ role: 'user', content: 'What is the weather in Prague?' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: ToolCallId('call_1'), name: 'get_weather', input: { city: 'Prague' } }],
			},
			{
				role: 'tool',
				toolCallId: ToolCallId('call_1'),
				content: 'Sunny, 22°C, light breeze from the west.',
			},
		]
		const messages = applyCacheBreakpoint(history, 0)

		const request = {
			model: ModelId('anthropic/claude-haiku-4.5'),
			systemPrompt: LARGE_SYSTEM_PROMPT,
			messages,
			tools: [weatherTool],
		}

		// First call primes the cache
		const first = await provider.inference(request)
		if (!first.ok) throw new Error(`first call failed: ${JSON.stringify(first.error)}`)
		expect(first.value.metrics.promptTokens).toBeGreaterThan(1024)

		// Second call — same prefix → cache read proves the write on call 1 was honored
		const second = await provider.inference(request)
		if (!second.ok) throw new Error(`second call failed: ${JSON.stringify(second.error)}`)
		expect(second.value.metrics.cachedTokens ?? 0).toBeGreaterThan(1024)
	}, 60_000)
})
