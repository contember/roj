/**
 * Integration tests for LLM providers against real APIs.
 *
 * Uses snapshot-caching fetch: first run hits the real API and saves the
 * request+response; subsequent runs with the same request use the cache.
 *
 * Env vars: ANTHROPIC_API_KEY, OPENROUTER_API_KEY
 * When snapshots exist, tests run without API keys (using cached responses).
 * API keys are only needed to record new snapshots.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import z4 from 'zod/v4'
import type { LLMMessage } from '~/core/agents/state.js'
import type { ImageProcessor } from '~/core/image/types.js'
import type { ToolDefinition } from '~/core/tools/definition.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenRouterProvider } from './openrouter.js'
import type { InferenceRequest, InferenceResponse, LLMProvider } from './provider.js'
import { ModelId } from './schema.js'
import { createSnapshotFetch } from './snapshot-fetch.js'

// ============================================================================
// Setup
// ============================================================================

const SNAPSHOTS_DIR = join(import.meta.dir, '__snapshots__')

const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? 'snapshot-only'
const openRouterApiKey = process.env.OPENROUTER_API_KEY ?? 'snapshot-only'

const noopImageProcessor: ImageProcessor = {
	resolveContent: async (content) => content,
}

// 1x1 red pixel PNG
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

const weatherTool: ToolDefinition<{ city: string }> = {
	name: 'get_weather',
	description: 'Get current weather for a city',
	input: z4.object({ city: z4.string() }),
	execute: async () => ({ ok: true, value: 'not implemented' }),
}

const searchTool: ToolDefinition<{ query: string }> = {
	name: 'search',
	description: 'Search the web',
	input: z4.object({ query: z4.string() }),
	execute: async () => ({ ok: true, value: 'not implemented' }),
}

// ============================================================================
// Provider factories
// ============================================================================

interface ProviderSetup {
	name: string
	model: ModelId
	hasApiKey: boolean
	snapshotPrefix: string
	create: (testName: string) => LLMProvider
}

const providers: ProviderSetup[] = [
	{
		name: 'Anthropic',
		model: ModelId('claude-haiku-4-5-20251001'),
		hasApiKey: !!process.env.ANTHROPIC_API_KEY,
		snapshotPrefix: 'anthropic',
		create: (testName) =>
			new AnthropicProvider({
				apiKey: anthropicApiKey!,
				imageProcessor: noopImageProcessor,
				defaultModel: 'claude-haiku-4-5-20251001',
				fetch: createSnapshotFetch(SNAPSHOTS_DIR, `anthropic-${testName}`),
			}),
	},
	{
		name: 'OpenRouter',
		model: ModelId('anthropic/claude-haiku-4.5'),
		hasApiKey: !!process.env.OPENROUTER_API_KEY,
		snapshotPrefix: 'openrouter',
		create: (testName) =>
			new OpenRouterProvider({
				apiKey: openRouterApiKey!,
				imageProcessor: noopImageProcessor,
				defaultModel: 'anthropic/claude-haiku-4.5',
				fetch: createSnapshotFetch(SNAPSHOTS_DIR, `openrouter-${testName}`),
			}),
	},
]

// ============================================================================
// Test scenarios
// ============================================================================

interface Scenario {
	name: string
	request: Omit<InferenceRequest, 'model'>
	assert: (response: InferenceResponse) => void
}

const scenarios: Scenario[] = [
	// --- Basic messages ---

	{
		name: 'simple-user-message',
		request: {
			systemPrompt: 'You are a helpful assistant. Reply with exactly one word.',
			messages: [{ role: 'user', content: 'What color is the sky? Reply with one word.' }],
		},
		assert: (r) => {
			expect(r.content).toBeTruthy()
			expect(r.finishReason).toBe('stop')
			expect(r.metrics.promptTokens).toBeGreaterThan(0)
			expect(r.metrics.completionTokens).toBeGreaterThan(0)
			expect(r.providerRequestId).toBeTruthy()
		},
	},

	{
		name: 'system-message-in-conversation',
		request: {
			systemPrompt: 'You are a helpful assistant.',
			messages: [
				{ role: 'user', content: 'Hi' },
				{ role: 'assistant', content: 'Hello!' },
				{ role: 'system', content: 'The user prefers Czech language.' },
				{ role: 'user', content: 'How are you?' },
			],
		},
		assert: (r) => {
			expect(r.content).toBeTruthy()
			expect(r.finishReason).toBe('stop')
		},
	},

	// --- Tool calls ---

	{
		name: 'tool-call',
		request: {
			systemPrompt: 'You have access to tools. Use the get_weather tool to answer weather questions.',
			messages: [{ role: 'user', content: 'What is the weather in Prague?' }],
			tools: [weatherTool],
		},
		assert: (r) => {
			expect(r.finishReason).toBe('tool_calls')
			expect(r.toolCalls.length).toBeGreaterThan(0)
			expect(r.toolCalls[0].name).toBe('get_weather')
			expect(r.toolCalls[0].input).toHaveProperty('city')
			expect(r.toolCalls[0].id).toBeTruthy()
		},
	},

	{
		name: 'tool-roundtrip',
		request: {
			systemPrompt: 'You have access to tools. Use them as needed. Be brief.',
			messages: [
				{ role: 'user', content: 'What is the weather in Prague?' },
				{
					role: 'assistant',
					content: '',
					toolCalls: [{ id: ToolCallId('call_001'), name: 'get_weather', input: { city: 'Prague' } }],
				},
				{
					role: 'tool',
					toolCallId: ToolCallId('call_001'),
					content: 'Sunny, 22°C',
				},
			],
			tools: [weatherTool],
		},
		assert: (r) => {
			expect(r.content).toBeTruthy()
			expect(r.finishReason).toBe('stop')
		},
	},

	{
		name: 'tool-error-result',
		request: {
			systemPrompt: 'You have access to tools. If a tool fails, explain the error to the user briefly.',
			messages: [
				{ role: 'user', content: 'What is the weather in Prague?' },
				{
					role: 'assistant',
					content: '',
					toolCalls: [{ id: ToolCallId('call_001'), name: 'get_weather', input: { city: 'Prague' } }],
				},
				{
					role: 'tool',
					toolCallId: ToolCallId('call_001'),
					content: 'Service unavailable: weather API is down',
					isError: true,
				},
			],
			tools: [weatherTool],
		},
		assert: (r) => {
			expect(r.content).toBeTruthy()
			expect(r.finishReason).toBe('stop')
		},
	},

	{
		name: 'assistant-text-with-tool-calls',
		request: {
			systemPrompt: 'You have access to tools. When asked about weather, first say you will check, then use the tool.',
			messages: [
				{ role: 'user', content: 'What is the weather in Prague and London?' },
				{
					role: 'assistant',
					content: 'Let me check the weather for both cities.',
					toolCalls: [
						{ id: ToolCallId('call_001'), name: 'get_weather', input: { city: 'Prague' } },
						{ id: ToolCallId('call_002'), name: 'get_weather', input: { city: 'London' } },
					],
				},
				{
					role: 'tool',
					toolCallId: ToolCallId('call_001'),
					content: 'Sunny, 22°C',
				},
				{
					role: 'tool',
					toolCallId: ToolCallId('call_002'),
					content: 'Rainy, 14°C',
				},
			],
			tools: [weatherTool],
		},
		assert: (r) => {
			expect(r.content).toBeTruthy()
			expect(r.finishReason).toBe('stop')
		},
	},

	{
		name: 'multiple-tool-calls-requested',
		request: {
			systemPrompt: 'You have access to tools. Use ALL relevant tools in a SINGLE response. Always call both tools when asked about weather and search.',
			messages: [{ role: 'user', content: 'Search for "Prague weather forecast" and also get the current weather in Prague using the weather tool.' }],
			tools: [weatherTool, searchTool],
		},
		assert: (r) => {
			expect(r.finishReason).toBe('tool_calls')
			expect(r.toolCalls.length).toBeGreaterThanOrEqual(2)
			const toolNames = r.toolCalls.map((tc) => tc.name)
			expect(toolNames).toContain('get_weather')
			expect(toolNames).toContain('search')
		},
	},

	// --- Images ---

	{
		name: 'image-data-url',
		request: {
			systemPrompt: 'Describe images briefly. One sentence.',
			messages: [{
				role: 'user',
				content: [
					{ type: 'text', text: 'What do you see in this image?' },
					{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${TINY_PNG}` } },
				],
			}],
		},
		assert: (r) => {
			expect(r.content).toBeTruthy()
			expect(r.finishReason).toBe('stop')
		},
	},

	{
		name: 'image-http-url',
		request: {
			systemPrompt: 'Describe images briefly. One sentence.',
			messages: [{
				role: 'user',
				content: [
					{ type: 'text', text: 'What do you see in this image?' },
					{ type: 'image_url', imageUrl: { url: 'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png' } },
				],
			}],
		},
		assert: (r) => {
			expect(r.content).toBeTruthy()
			expect(r.finishReason).toBe('stop')
		},
	},

	{
		name: 'multiple-images',
		request: {
			systemPrompt: 'Describe what you see. Be brief.',
			messages: [{
				role: 'user',
				content: [
					{ type: 'text', text: 'How many images do you see? What colors?' },
					{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${TINY_PNG}` } },
					{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${TINY_PNG}` } },
				],
			}],
		},
		assert: (r) => {
			expect(r.content).toBeTruthy()
			expect(r.finishReason).toBe('stop')
		},
	},

	{
		name: 'tool-result-with-image',
		request: {
			systemPrompt: 'You have access to tools. Describe tool results briefly.',
			messages: [
				{ role: 'user', content: 'Take a screenshot' },
				{
					role: 'assistant',
					content: '',
					toolCalls: [{ id: ToolCallId('call_001'), name: 'search', input: { query: 'screenshot' } }],
				},
				{
					role: 'tool',
					toolCallId: ToolCallId('call_001'),
					content: [
						{ type: 'text', text: 'Here is the screenshot:' },
						{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${TINY_PNG}` } },
					],
				},
			],
			tools: [searchTool],
		},
		assert: (r) => {
			expect(r.content).toBeTruthy()
			expect(r.finishReason).toBe('stop')
		},
	},

	// --- Edge cases / message merging ---

	{
		name: 'consecutive-tool-results',
		request: {
			systemPrompt: 'You have access to tools. Summarize all results briefly.',
			messages: [
				{ role: 'user', content: 'Get weather in Prague and London.' },
				{
					role: 'assistant',
					content: '',
					toolCalls: [
						{ id: ToolCallId('call_001'), name: 'get_weather', input: { city: 'Prague' } },
						{ id: ToolCallId('call_002'), name: 'get_weather', input: { city: 'London' } },
					],
				},
				{
					role: 'tool',
					toolCallId: ToolCallId('call_001'),
					content: 'Sunny, 22°C',
				},
				{
					role: 'tool',
					toolCallId: ToolCallId('call_002'),
					content: 'Rainy, 14°C',
				},
			],
			tools: [weatherTool],
		},
		assert: (r) => {
			expect(r.content).toBeTruthy()
			expect(r.finishReason).toBe('stop')
		},
	},
]

// ============================================================================
// Run all scenarios against all providers
// ============================================================================

for (const provider of providers) {
	describe(`${provider.name} integration`, () => {
		for (const scenario of scenarios) {
			const snapshotPath = join(SNAPSHOTS_DIR, `${provider.snapshotPrefix}-${scenario.name}.json`)
			const hasSnapshot = existsSync(snapshotPath)
			const shouldSkip = !provider.hasApiKey && !hasSnapshot

			test.skipIf(shouldSkip)(scenario.name, async () => {
				const llm = provider.create(scenario.name)

				const result = await llm.inference({
					model: provider.model,
					...scenario.request,
				})

				if (!result.ok) {
					throw new Error(`LLM inference failed: ${JSON.stringify(result.error)}`)
				}

				scenario.assert(result.value)
			})
		}
	})
}
