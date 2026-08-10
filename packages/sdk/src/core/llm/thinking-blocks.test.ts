import { describe, expect, test } from 'bun:test'
import type { LLMMessage } from '~/core/agents/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { isOk } from '~/lib/utils/result.js'
import { AnthropicProvider } from './anthropic.js'
import type { InferenceRequest, RawInferenceRequest } from './provider.js'
import { ModelId } from './schema.js'

// ============================================================================
// Extended thinking round trip
// ============================================================================
//
// Anthropic returns `thinking` blocks carrying a `signature` it verifies, and during
// tool use it requires the block sequence back on the assistant turn that made the
// tool call. So unlike OpenRouter — where dropping the blocks silently degrades the
// model — dropping them here is a hard API error the moment thinking is switched on.
//
// The blocks are opaque to the SDK. What these tests pin down is that they come back
// byte-identical and in the position the API expects, and that a response with no
// thinking produces exactly the request bytes it did before.

const testModel = ModelId('claude-sonnet-4-6')

/** Shape from the Anthropic docs. Signatures are truncated but structurally real. */
const THINKING_BLOCKS = [
	{
		type: 'thinking',
		thinking: 'The user is asking about the weather. I should call the tool.',
		signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1KkiMOYds',
	},
	{
		type: 'redacted_thinking',
		data: 'EmwKAhgBEgy3va3POvlKN51xeoMaDC3sTb2z0opaque',
	},
]

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const createProvider = (fetchFn?: FetchFn) =>
	new AnthropicProvider({
		apiKey: 'test-key',
		imageProcessor: { resolveContent: async (content) => content },
		defaultModel: String(testModel),
		fetch: fetchFn,
	})

const respondWith = (content: unknown[]): FetchFn => async () =>
	new Response(
		JSON.stringify({
			id: 'msg_1',
			model: String(testModel),
			content,
			stop_reason: 'end_turn',
			usage: { input_tokens: 10, output_tokens: 5 },
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

/**
 * The assistant message as it reaches the API, after mapping and merging.
 *
 * A trailing user turn is appended because the provider refuses a history that ends on an
 * assistant message — the same reason the real loop always has something after it.
 */
const assistantBlocks = async (...messages: LLMMessage[]): Promise<unknown[]> => {
	const http = await createProvider().buildHttpRequest(
		rawRequest([{ role: 'user', content: 'Hi' }, ...messages, { role: 'user', content: 'And?' }]),
	)
	const body = http.body
	if (typeof body !== 'object' || body === null || !('messages' in body) || !Array.isArray(body.messages)) {
		throw new Error('unexpected request body')
	}
	const assistant = body.messages.find((m: { role: string }) => m.role === 'assistant')
	if (!assistant || !Array.isArray(assistant.content)) throw new Error('no assistant message with block content')
	return assistant.content
}

describe('Anthropic thinking capture', () => {
	test('captures the blocks whole, signatures included, alongside the plaintext', async () => {
		const provider = createProvider(respondWith([...THINKING_BLOCKS, { type: 'text', text: 'Sunny.' }]))

		const result = await provider.inference(inferenceRequest())

		expect(isOk(result)).toBe(true)
		if (!isOk(result)) return
		// Verbatim: the signature is what the API verifies on replay, so nothing may be rebuilt.
		expect(result.value.thinkingBlocks).toEqual(THINKING_BLOCKS)
		expect(result.value.reasoning).toBe('The user is asking about the weather. I should call the tool.')
		expect(result.value.content).toBe('Sunny.')
	})

	test('leaves both fields unset when thinking is off', async () => {
		const provider = createProvider(respondWith([{ type: 'text', text: 'Sunny.' }]))

		const result = await provider.inference(inferenceRequest())

		if (!isOk(result)) throw new Error(`inference failed: ${result.error.type} — ${result.error.message}`)
		expect(result.value.thinkingBlocks).toBeUndefined()
		expect(result.value.reasoning).toBeUndefined()
	})

	// redacted_thinking has no readable text, but the API still wants it back in sequence.
	test('keeps a redacted block even though it contributes no plaintext', async () => {
		const redacted = [{ type: 'redacted_thinking', data: 'EmwKAhgBEgy3opaque' }]
		const provider = createProvider(respondWith([...redacted, { type: 'text', text: 'Done.' }]))

		const result = await provider.inference(inferenceRequest())

		expect(isOk(result)).toBe(true)
		if (!isOk(result)) return
		expect(result.value.thinkingBlocks).toEqual(redacted)
		expect(result.value.reasoning).toBeUndefined()
	})
})

describe('Anthropic thinking echo', () => {
	test('replays the blocks first, ahead of text and tool calls', async () => {
		const blocks = await assistantBlocks(
			{
				role: 'assistant',
				content: 'Let me check.',
				thinkingBlocks: THINKING_BLOCKS,
				toolCalls: [{ id: ToolCallId('toolu_1'), name: 'get_weather', input: { city: 'Prague' } }],
			},
			{ role: 'tool', toolCallId: ToolCallId('toolu_1'), content: 'Sunny, 22°C' },
		)

		// Order is the API's requirement, not a preference.
		expect(blocks).toEqual([
			...THINKING_BLOCKS,
			{ type: 'text', text: 'Let me check.' },
			{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Prague' } },
		])
	})

	test('replays them on an assistant message that made no tool call', async () => {
		const blocks = await assistantBlocks({ role: 'assistant', content: 'Sunny.', thinkingBlocks: THINKING_BLOCKS })

		expect(blocks).toEqual([...THINKING_BLOCKS, { type: 'text', text: 'Sunny.' }])
	})

	// All or nothing: the API rejects an edited or partial sequence, so a set that cannot be
	// recognised in full is dropped in full rather than sent truncated. Reachable if a session
	// switches provider mid-conversation and foreign blocks reach this field.
	test('drops the whole set when any block is unrecognisable', async () => {
		const blocks = await assistantBlocks({
			role: 'assistant',
			content: 'Sunny.',
			thinkingBlocks: [THINKING_BLOCKS[0], { type: 'reasoning.summary', summary: 'from another provider' }],
		})

		expect(blocks).toEqual([{ type: 'text', text: 'Sunny.' }])
	})

	test('drops a thinking block whose signature is missing', async () => {
		const blocks = await assistantBlocks({
			role: 'assistant',
			content: 'Sunny.',
			thinkingBlocks: [{ type: 'thinking', thinking: 'no signature here' }],
		})

		expect(blocks).toEqual([{ type: 'text', text: 'Sunny.' }])
	})
})

describe('Anthropic request bytes without thinking', () => {
	// The prompt cache is keyed on the serialized prefix, so a message with no thinking has to
	// serialize exactly as it did before this feature existed.
	test('adds nothing to a plain assistant message', async () => {
		const http = await createProvider().buildHttpRequest(rawRequest([
			{ role: 'user', content: 'What is 2+2?' },
			{ role: 'assistant', content: '4' },
			{ role: 'user', content: 'And 3+3?' },
		]))

		expect(JSON.stringify(http.body)).not.toContain('thinking')
	})

	test('adds nothing to an assistant message with tool calls', async () => {
		const http = await createProvider().buildHttpRequest(rawRequest([
			{ role: 'user', content: 'Weather?' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: ToolCallId('toolu_1'), name: 'get_weather', input: { city: 'Prague' } }],
			},
			{ role: 'tool', toolCallId: ToolCallId('toolu_1'), content: 'Sunny, 22°C' },
		]))

		expect(JSON.stringify(http.body)).not.toContain('thinking')
	})
})

describe('Anthropic cache breakpoints around thinking', () => {
	// cache_control on a replayed thinking block is an extra key on a signed payload — rejected.
	// The breakpoint moves to the last block that can hold one.
	test('puts the breakpoint on the text block, not the thinking block', async () => {
		const blocks = await assistantBlocks({
			role: 'assistant',
			content: 'Sunny.',
			thinkingBlocks: THINKING_BLOCKS,
			cacheControl: { type: 'ephemeral' },
		})

		expect(blocks).toEqual([
			...THINKING_BLOCKS,
			{ type: 'text', text: 'Sunny.', cache_control: { type: 'ephemeral' } },
		])
	})

	// Nothing in the message can carry it. Losing a breakpoint is a cache miss; sending an
	// invalid one is a failed request.
	test('places no breakpoint when the message is nothing but thinking', async () => {
		const blocks = await assistantBlocks({
			role: 'assistant',
			content: '',
			thinkingBlocks: THINKING_BLOCKS,
			cacheControl: { type: 'ephemeral' },
		})

		expect(blocks).toEqual(THINKING_BLOCKS)
	})
})

// ============================================================================
// Live verification
// ============================================================================
//
// Everything above runs against a mocked fetch, which proves the shape the SDK builds
// and nothing about whether Anthropic accepts it. This drives the real API through a
// full tool-use cycle with extended thinking on — the exact flow that returns a 400
// when the thinking blocks are missing from the assistant turn.
//
//   LIVE_TESTS=1 ANTHROPIC_API_KEY=… bun test thinking-blocks

const liveEnabled = process.env.LIVE_TESTS === '1'
const liveApiKey = liveEnabled ? process.env.ANTHROPIC_API_KEY : undefined

const describeLive = (name: string, fn: () => void) => {
	if (!liveApiKey) {
		describe.skip(`${name} (skipped — LIVE_TESTS=1 + ANTHROPIC_API_KEY required)`, fn)
		return
	}
	describe(name, fn)
}

/** Records every outbound body so the echo can be proven on the wire, not inferred. */
const createRecordingFetch = (sink: unknown[]): FetchFn => async (input, init) => {
	sink.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'))
	return globalThis.fetch(input, init)
}

const liveModel = ModelId('claude-sonnet-4-6')

const weatherTool = {
	name: 'get_weather',
	description: 'Get the current weather for a city.',
	parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}

describeLive('Anthropic extended thinking, live', () => {
	test('a tool-use turn survives the round trip with thinking enabled', async () => {
		const sent: unknown[] = []
		const provider = new AnthropicProvider({
			apiKey: liveApiKey ?? '',
			imageProcessor: { resolveContent: async (content) => content },
			defaultModel: String(liveModel),
			// Anthropic's floor. Enough to make the model actually think.
			thinkingBudget: 1024,
			fetch: createRecordingFetch(sent),
		})

		const first = await provider.inference({
			model: liveModel,
			systemPrompt: 'You answer weather questions. Always use the tool; never guess.',
			messages: [{ role: 'user', content: 'What is the weather in Prague right now?' }],
			maxTokens: 2048,
			tools: [],
			anthropic: { thinkingBudget: 1024 },
		}, undefined)

		if (!isOk(first)) throw new Error(`first inference failed: ${first.error.type} — ${first.error.message}`)
		// Thinking has to be on for this test to mean anything.
		expect(first.value.thinkingBlocks?.length).toBeGreaterThan(0)

		// Replay the captured blocks on the assistant turn, exactly as the agent loop would.
		const second = await provider.inference({
			model: liveModel,
			systemPrompt: 'You answer weather questions. Always use the tool; never guess.',
			messages: [
				{ role: 'user', content: 'What is the weather in Prague right now?' },
				{
					role: 'assistant',
					content: first.value.content ?? '',
					thinkingBlocks: first.value.thinkingBlocks,
				},
				{ role: 'user', content: 'Thanks. Reply with the single word OK.' },
			],
			maxTokens: 2048,
			anthropic: { thinkingBudget: 1024 },
		}, undefined)

		// The assertion that matters: the API accepted the replayed, signed blocks.
		if (!isOk(second)) throw new Error(`replay rejected: ${second.error.type} — ${second.error.message}`)

		// Proven on the wire: the blocks in the second outbound body are byte-identical to
		// the ones the API returned on the first call.
		const secondBody = JSON.stringify(sent[1])
		expect(secondBody).toContain(JSON.stringify(first.value.thinkingBlocks?.[0]))
		console.log(`LIVE OK ${JSON.stringify({ blocks: first.value.thinkingBlocks?.length, reply: second.value.content })}`)
	}, 120_000)

	test('no thinking key on the wire when thinking is off', async () => {
		const sent: unknown[] = []
		const provider = new AnthropicProvider({
			apiKey: liveApiKey ?? '',
			imageProcessor: { resolveContent: async (content) => content },
			defaultModel: String(liveModel),
			fetch: createRecordingFetch(sent),
		})

		const result = await provider.inference({
			model: liveModel,
			systemPrompt: 'Answer in one word.',
			messages: [{ role: 'user', content: 'What is 2+2?' }],
			maxTokens: 64,
		}, undefined)

		if (!isOk(result)) throw new Error(`inference failed: ${result.error.type} — ${result.error.message}`)
		expect(result.value.thinkingBlocks).toBeUndefined()
		expect(JSON.stringify(sent[0])).not.toContain('thinking')
	}, 120_000)
})
