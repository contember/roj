import { describe, expect, spyOn, test } from 'bun:test'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { type AnthropicConfig, AnthropicProvider } from './anthropic.js'
import { OpenRouterProvider } from './openrouter.js'
import { type InferenceContext, LLMMessageFactory } from './provider.js'
import { ModelId } from './schema.js'

type ProviderFetch = NonNullable<AnthropicConfig['fetch']>

const spyOnGlobalFetch = (implementation: ProviderFetch) => {
	const fetchWithPreconnect = Object.assign(implementation, { preconnect: globalThis.fetch.preconnect })
	return spyOn(globalThis, 'fetch').mockImplementation(fetchWithPreconnect)
}

const providers = [
	{
		name: 'Anthropic',
		create: (config: AnthropicConfig) => new AnthropicProvider(config),
		url: 'https://api.anthropic.com/v1/messages',
		response: {
			id: 'msg-test',
			model: 'claude-opus-4-6',
			content: [{ type: 'text', text: 'Hello back' }],
			stop_reason: 'end_turn',
			usage: { input_tokens: 10, output_tokens: 5 },
		},
	},
	{
		name: 'OpenRouter',
		create: (config: AnthropicConfig) => new OpenRouterProvider(config),
		url: 'https://openrouter.ai/api/v1/chat/completions',
		response: {
			id: 'msg-test',
			model: 'claude-opus-4-6',
			choices: [{ message: { role: 'assistant', content: 'Hello back' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		},
	},
]

const request = { messages: [LLMMessageFactory.user('hi')], model: ModelId('claude-opus-4-6'), systemPrompt: '' }
const fileStore = new SessionFileStore('/tmp/opencode/roj-provider-fetch-test', undefined, false, createNodeFileSystem(), 'session')
const contextWith = (signal: AbortSignal): InferenceContext => ({ sessionId: 'session-1', agentId: 'agent-1', signal, fileStore })

for (const fixture of providers) {
	describe(`${fixture.name} fetch transport`, () => {
		for (const transport of ['global', 'configured']) {
			test.serial(`${transport} fetch completes inference with the expected receiver`, async () => {
				const receivers: unknown[] = []
				const calls: { input: string | URL | Request; init?: RequestInit }[] = []
				const fetchFn = function (this: unknown, input: string | URL | Request, init?: RequestInit): Promise<Response> {
					receivers.push(this)
					calls.push({ input, init })
					if (this !== (transport === 'global' ? globalThis : customTransport)) {
						throw new TypeError('Illegal invocation')
					}
					return Promise.resolve(Response.json(fixture.response))
				}
				const customTransport = { fetch: fetchFn }
				const globalFetch = spyOnGlobalFetch(transport === 'global' ? fetchFn : () => Promise.reject(new Error('Unexpected global fetch')))
				try {
					const provider = fixture.create({
						apiKey: 'test-key',
						imageProcessor: { resolveContent: async (content) => content },
						fetch: transport === 'configured' ? customTransport.fetch.bind(customTransport) : undefined,
					})
					const result = await provider.inference(request)
					expect(result.ok).toBe(true)
					if (!result.ok) throw new Error(result.error.message)
					expect(result.value).toMatchObject({ content: 'Hello back', finishReason: 'stop', toolCalls: [], providerRequestId: 'msg-test' })
					expect(calls).toHaveLength(1)
					expect(calls[0]?.input).toBe(fixture.url)
					expect(calls[0]?.init?.method).toBe('POST')
					expect(receivers[0]).toBe(transport === 'global' ? globalThis : customTransport)
					expect(globalFetch).toHaveBeenCalledTimes(transport === 'global' ? 1 : 0)
				} finally {
					globalFetch.mockRestore()
				}
			})

			for (const cause of ['caller', 'timeout']) {
				test.serial(`${transport} fetch receives ${cause} cancellation`, async () => {
					const started = Promise.withResolvers<AbortSignal>()
					let abortCount = 0
					const fetchFn: ProviderFetch = (_input, init) => {
						const signal = init?.signal
						if (!signal) throw new Error('Fetch did not receive a signal')
						started.resolve(signal)
						return new Promise<Response>((_resolve, reject) => {
							const onAbort = () => {
								abortCount++
								reject(new DOMException('Aborted', 'AbortError'))
							}
							if (signal.aborted) onAbort()
							else signal.addEventListener('abort', onAbort, { once: true })
						})
					}
					const globalFetch = spyOnGlobalFetch(transport === 'global' ? fetchFn : () => Promise.reject(new Error('Unexpected global fetch')))
					const controller = new AbortController()
					try {
						const provider = fixture.create({
							apiKey: 'test-key',
							timeout: cause === 'timeout' ? 10 : 60_000,
							imageProcessor: { resolveContent: async (content) => content },
							fetch: transport === 'configured' ? fetchFn : undefined,
						})
						const pending = provider.inference(request, contextWith(controller.signal))
						const signal = await Promise.race([
							started.promise,
							pending.then(() => {
								throw new Error('Inference completed before fetch received cancellation')
							}),
						])
						expect(signal.aborted).toBe(false)
						if (cause === 'caller') controller.abort()
						const result = await pending
						expect(signal.aborted).toBe(true)
						expect(abortCount).toBe(1)
						expect(result.ok).toBe(false)
						if (result.ok) throw new Error('Cancelled inference unexpectedly succeeded')
						expect(result.error.type).toBe(cause === 'caller' ? 'aborted' : 'timeout')
						expect(controller.signal.aborted).toBe(cause === 'caller')
						expect(globalFetch).toHaveBeenCalledTimes(transport === 'global' ? 1 : 0)
					} finally {
						controller.abort()
						globalFetch.mockRestore()
					}
				})
			}
		}
	})
}
