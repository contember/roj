import { describe, expect, test } from 'bun:test'
import type { LLMMessage } from '~/core/agents/state.js'
import { isOk } from '~/lib/utils/result.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { OpenRouterProvider } from './openrouter.js'
import type { InferenceRequest, RawInferenceRequest } from './provider.js'
import { ModelId } from './schema.js'

// ============================================================================
// reasoning_details round trip
// ============================================================================
//
// OpenRouter returns `reasoning_details` on an assistant message and expects the
// exact sequence back on the following requests, or a reasoning model loses its
// chain of thought at every tool call. The blocks are opaque, so what matters is
// that they come back byte-identical — and that a model which never reasons
// keeps producing the same request bytes, since the prompt cache is keyed on them.

const testModel = ModelId('openai/gpt-5.6-luna')

/** Shape taken from the OpenRouter docs; treated as opaque everywhere in the SDK. */
const REASONING_DETAILS = [
	{
		type: 'reasoning.summary',
		summary: 'Analyzed the problem by breaking it into components',
		id: 'reasoning-summary-1',
		format: 'anthropic-claude-v1',
		index: 0,
	},
	{
		type: 'reasoning.encrypted',
		data: 'EroBCkYIBRgCKkCr0hZ0opaque',
		id: 'reasoning-encrypted-1',
		format: 'openai-responses-v1',
		index: 1,
	},
]

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const createProvider = (fetchFn?: FetchFn) =>
	new OpenRouterProvider({
		apiKey: 'test-key',
		imageProcessor: { resolveContent: async (content) => content },
		defaultModel: String(testModel),
		fetch: fetchFn,
	})

const respondWith = (message: Record<string, unknown>): FetchFn => async () =>
	new Response(
		JSON.stringify({
			id: 'gen-1',
			model: String(testModel),
			choices: [{ message, finish_reason: 'stop' }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	)

const inferenceRequest = (): InferenceRequest => ({
	model: testModel,
	systemPrompt: 'You are helpful.',
	messages: [{ role: 'user', content: 'What is the weather?' }],
})

const rawRequest = (messages: LLMMessage[]): RawInferenceRequest => ({
	model: testModel,
	systemPrompt: 'You are helpful.',
	messages,
})

describe('OpenRouter reasoning_details capture', () => {
	test('captures the blocks and the plaintext reasoning from a response', async () => {
		const provider = createProvider(respondWith({
			content: 'It is sunny.',
			reasoning: 'The user asked about weather, so I check the tool first.',
			reasoning_details: REASONING_DETAILS,
		}))

		const result = await provider.inference(inferenceRequest())

		expect(isOk(result)).toBe(true)
		if (!isOk(result)) return
		expect(result.value.reasoningDetails).toEqual(REASONING_DETAILS)
		expect(result.value.reasoning).toBe('The user asked about weather, so I check the tool first.')
	})

	test('leaves both fields unset for a model that does not reason', async () => {
		const provider = createProvider(respondWith({ content: 'It is sunny.' }))

		const result = await provider.inference(inferenceRequest())

		expect(isOk(result)).toBe(true)
		if (!isOk(result)) return
		expect(result.value.reasoningDetails).toBeUndefined()
		expect(result.value.reasoning).toBeUndefined()
	})

	test('normalizes an empty block list to undefined, so nothing is echoed back', async () => {
		const provider = createProvider(respondWith({ content: 'It is sunny.', reasoning_details: [] }))

		const result = await provider.inference(inferenceRequest())

		expect(isOk(result)).toBe(true)
		if (!isOk(result)) return
		expect(result.value.reasoningDetails).toBeUndefined()
	})
})

describe('OpenRouter reasoning_details echo', () => {
	test('sends the blocks back verbatim on the assistant message', async () => {
		const http = await createProvider().buildHttpRequest(rawRequest([
			{ role: 'user', content: 'What is the weather?' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: ToolCallId('call_1'), name: 'get_weather', input: { city: 'Prague' } }],
				reasoningDetails: REASONING_DETAILS,
			},
			{ role: 'tool', toolCallId: ToolCallId('call_1'), content: 'Sunny' },
		]))

		// Serialized comparison, because "verbatim" is a claim about the bytes on the
		// wire — a deep-equal check would pass even if the blocks were rebuilt.
		const assistant = '{"role":"assistant","content":"","tool_calls":['
			+ '{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Prague\\"}"}}'
			+ `],"reasoning_details":${JSON.stringify(REASONING_DETAILS)}}`
		expect(JSON.stringify(http.body)).toContain(assistant)
	})

	test('echoes the blocks on an assistant message that made no tool call', async () => {
		const http = await createProvider().buildHttpRequest(rawRequest([
			{ role: 'user', content: 'Think about it.' },
			{ role: 'assistant', content: 'Thought about it.', reasoningDetails: REASONING_DETAILS },
			{ role: 'user', content: 'And now?' },
		]))

		expect(JSON.stringify(http.body)).toContain(
			`{"role":"assistant","content":"Thought about it.","reasoning_details":${JSON.stringify(REASONING_DETAILS)}}`,
		)
	})
})

describe('OpenRouter request bytes without reasoning', () => {
	// The prompt cache is keyed on the serialized prefix, so a key that appears
	// even as `null`/`undefined` for a non-reasoning model would rewrite it.
	test('adds nothing to a plain assistant message', async () => {
		const http = await createProvider().buildHttpRequest(rawRequest([
			{ role: 'user', content: 'What is 2+2?' },
			{ role: 'assistant', content: '4' },
			{ role: 'user', content: 'And 3+3?' },
		]))

		const body = JSON.stringify(http.body)
		expect(body).toContain('{"role":"assistant","content":"4"}')
		expect(body).not.toContain('reasoning')
	})

	test('adds nothing to an assistant message with tool calls', async () => {
		const http = await createProvider().buildHttpRequest(rawRequest([
			{ role: 'user', content: 'What is the weather?' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: ToolCallId('call_1'), name: 'get_weather', input: { city: 'Prague' } }],
			},
			{ role: 'tool', toolCallId: ToolCallId('call_1'), content: 'Sunny' },
		]))

		const body = JSON.stringify(http.body)
		expect(body).toContain(
			'{"role":"assistant","content":"","tool_calls":['
			+ '{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Prague\\"}"}}]}',
		)
		expect(body).not.toContain('reasoning')
	})
})
