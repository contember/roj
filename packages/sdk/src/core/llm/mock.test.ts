import { beforeEach, describe, expect, test } from 'bun:test'
import z from 'zod/v4'
import { isErr, isOk } from '~/lib/utils/result.js'
import { MockLLMProvider, RequestMatchers } from './mock.js'
import type { InferenceRequest, LLMError } from './provider.js'
import { ModelId } from './schema.js'

describe('MockLLMProvider', () => {
	const createRequest = (
		overrides: Partial<InferenceRequest> = {},
	): InferenceRequest => ({
		model: ModelId('test-model'),
		systemPrompt: 'You are a test assistant.',
		messages: [{ role: 'user', content: 'Hello' }],
		...overrides,
	})

	describe('basic inference', () => {
		test('calls handler and returns response', async () => {
			const provider = new MockLLMProvider(() => ({
				content: 'Hello, world!',
				toolCalls: [],
				finishReason: 'stop',
				metrics: MockLLMProvider.defaultMetrics(),
			}))

			const result = await provider.inference(createRequest())

			expect(isOk(result)).toBe(true)
			if (isOk(result)) {
				expect(result.value.content).toBe('Hello, world!')
				expect(result.value.finishReason).toBe('stop')
			}
		})

		test('supports async handlers', async () => {
			const provider = new MockLLMProvider(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10))
				return {
					content: 'Async response',
					toolCalls: [],
					finishReason: 'stop',
					metrics: MockLLMProvider.defaultMetrics(),
				}
			})

			const result = await provider.inference(createRequest())

			expect(isOk(result)).toBe(true)
			if (isOk(result)) {
				expect(result.value.content).toBe('Async response')
			}
		})

		test('catches handler errors and returns server_error', async () => {
			const provider = new MockLLMProvider(() => {
				throw new Error('Something went wrong')
			})

			const result = await provider.inference(createRequest())

			expect(isErr(result)).toBe(true)
			if (isErr(result)) {
				expect(result.error.type).toBe('server_error')
				expect(result.error.message).toBe('Something went wrong')
			}
		})

		test('passes through LLMError from handler', async () => {
			const llmError: LLMError = {
				type: 'rate_limit',
				message: 'Too many requests',
				retryAfterMs: 5000,
			}

			const provider = new MockLLMProvider(() => {
				throw llmError
			})

			const result = await provider.inference(createRequest())

			expect(isErr(result)).toBe(true)
			if (isErr(result)) {
				expect(result.error.type).toBe('rate_limit')
				expect(result.error.message).toBe('Too many requests')
				expect(result.error.retryAfterMs).toBe(5000)
			}
		})
	})

	describe('test helpers', () => {
		let provider: MockLLMProvider

		beforeEach(() => {
			provider = new MockLLMProvider(() => ({
				content: 'Test response',
				toolCalls: [],
				finishReason: 'stop',
				metrics: MockLLMProvider.defaultMetrics(),
			}))
		})

		test('getCallHistory returns copy of call history', async () => {
			const request1 = createRequest({ systemPrompt: 'Prompt 1' })
			const request2 = createRequest({ systemPrompt: 'Prompt 2' })

			await provider.inference(request1)
			await provider.inference(request2)

			const history = provider.getCallHistory()
			expect(history).toHaveLength(2)
			expect(history[0]?.systemPrompt).toBe('Prompt 1')
			expect(history[1]?.systemPrompt).toBe('Prompt 2')

			// Verify it's a copy
			history.pop()
			expect(provider.getCallHistory()).toHaveLength(2)
		})

		test('getCallCount returns correct count', async () => {
			expect(provider.getCallCount()).toBe(0)

			await provider.inference(createRequest())
			expect(provider.getCallCount()).toBe(1)

			await provider.inference(createRequest())
			await provider.inference(createRequest())
			expect(provider.getCallCount()).toBe(3)
		})

		test('clearHistory clears all recorded calls', async () => {
			await provider.inference(createRequest())
			await provider.inference(createRequest())
			expect(provider.getCallCount()).toBe(2)

			provider.clearHistory()

			expect(provider.getCallCount()).toBe(0)
			expect(provider.getCallHistory()).toEqual([])
		})

		test('getLastRequest returns the last request', async () => {
			expect(provider.getLastRequest()).toBeUndefined()

			await provider.inference(createRequest({ systemPrompt: 'First' }))
			expect(provider.getLastRequest()?.systemPrompt).toBe('First')

			await provider.inference(createRequest({ systemPrompt: 'Second' }))
			expect(provider.getLastRequest()?.systemPrompt).toBe('Second')
		})
	})

	describe('factory methods', () => {
		describe('withFixedResponse', () => {
			test('returns same response every time', async () => {
				const provider = MockLLMProvider.withFixedResponse({
					content: 'Fixed response',
				})

				const result1 = await provider.inference(createRequest())
				const result2 = await provider.inference(createRequest())

				expect(isOk(result1)).toBe(true)
				expect(isOk(result2)).toBe(true)
				if (isOk(result1) && isOk(result2)) {
					expect(result1.value.content).toBe('Fixed response')
					expect(result2.value.content).toBe('Fixed response')
				}
			})

			test('fills in default values for missing fields', async () => {
				const provider = MockLLMProvider.withFixedResponse({
					content: 'Just content',
				})

				const result = await provider.inference(createRequest())

				expect(isOk(result)).toBe(true)
				if (isOk(result)) {
					expect(result.value.content).toBe('Just content')
					expect(result.value.toolCalls).toEqual([])
					expect(result.value.finishReason).toBe('stop')
					expect(result.value.metrics).toEqual(MockLLMProvider.defaultMetrics())
				}
			})
		})

		describe('withSequence', () => {
			test('returns responses in sequence', async () => {
				const provider = MockLLMProvider.withSequence([
					{ content: 'First' },
					{ content: 'Second' },
					{ content: 'Third' },
				])

				const result1 = await provider.inference(createRequest())
				const result2 = await provider.inference(createRequest())
				const result3 = await provider.inference(createRequest())

				expect(isOk(result1) && result1.value.content).toBe('First')
				expect(isOk(result2) && result2.value.content).toBe('Second')
				expect(isOk(result3) && result3.value.content).toBe('Third')
			})

			test('throws when sequence is exhausted', async () => {
				const provider = MockLLMProvider.withSequence([{ content: 'Only one' }])

				await provider.inference(createRequest())
				const result = await provider.inference(createRequest())

				expect(isErr(result)).toBe(true)
				if (isErr(result)) {
					expect(result.error.message).toBe('No more mock responses available')
				}
			})
		})

		describe('withError', () => {
			test('always returns the specified error', async () => {
				const error: LLMError = {
					type: 'context_length',
					message: 'Context too long',
				}
				const provider = MockLLMProvider.withError(error)

				const result1 = await provider.inference(createRequest())
				const result2 = await provider.inference(createRequest())

				expect(isErr(result1)).toBe(true)
				expect(isErr(result2)).toBe(true)
				if (isErr(result1)) {
					expect(result1.error.type).toBe('context_length')
					expect(result1.error.message).toBe('Context too long')
				}
			})
		})

		describe('withMatcher', () => {
			test('matches based on request content', async () => {
				const provider = MockLLMProvider.withMatcher([
					{
						match: (req) => {
							const content = req.messages[0]?.content
							return typeof content === 'string' && content.includes('hello')
						},
						response: { content: 'Hello response' },
					},
					{
						match: (req) => {
							const content = req.messages[0]?.content
							return typeof content === 'string' && content.includes('bye')
						},
						response: { content: 'Goodbye response' },
					},
				])

				const helloResult = await provider.inference(
					createRequest({ messages: [{ role: 'user', content: 'hello there' }] }),
				)
				const byeResult = await provider.inference(
					createRequest({ messages: [{ role: 'user', content: 'bye now' }] }),
				)

				expect(isOk(helloResult) && helloResult.value.content).toBe(
					'Hello response',
				)
				expect(isOk(byeResult) && byeResult.value.content).toBe(
					'Goodbye response',
				)
			})

			test('uses first matching response', async () => {
				const provider = MockLLMProvider.withMatcher([
					{
						match: () => true,
						response: { content: 'First matcher' },
					},
					{
						match: () => true,
						response: { content: 'Second matcher' },
					},
				])

				const result = await provider.inference(createRequest())

				expect(isOk(result) && result.value.content).toBe('First matcher')
			})

			test('uses default response when no matcher matches', async () => {
				const provider = MockLLMProvider.withMatcher(
					[
						{
							match: (req) => {
								const content = req.messages[0]?.content
								return typeof content === 'string' && content.includes('specific')
							},
							response: { content: 'Specific response' },
						},
					],
					{ content: 'Default response' },
				)

				const result = await provider.inference(
					createRequest({ messages: [{ role: 'user', content: 'generic message' }] }),
				)

				expect(isOk(result) && result.value.content).toBe('Default response')
			})

			test('throws when no match and no default', async () => {
				const provider = MockLLMProvider.withMatcher([
					{
						match: (req) => {
							const content = req.messages[0]?.content
							return typeof content === 'string' && content.includes('specific')
						},
						response: { content: 'Specific response' },
					},
				])

				const result = await provider.inference(
					createRequest({ messages: [{ role: 'user', content: 'generic message' }] }),
				)

				expect(isErr(result)).toBe(true)
				if (isErr(result)) {
					expect(result.error.message).toBe('No matching mock response found')
				}
			})
		})
	})

	describe('RequestMatchers', () => {
		describe('lastMessageContains', () => {
			test('matches when last message contains text', () => {
				const matcher = RequestMatchers.lastMessageContains('hello')

				const matchingRequest = createRequest({
					messages: [
						{ role: 'user', content: 'first' },
						{ role: 'user', content: 'hello world' },
					],
				})
				const nonMatchingRequest = createRequest({
					messages: [{ role: 'user', content: 'goodbye' }],
				})
				const emptyRequest = createRequest({ messages: [] })

				expect(matcher(matchingRequest)).toBe(true)
				expect(matcher(nonMatchingRequest)).toBe(false)
				expect(matcher(emptyRequest)).toBe(false)
			})
		})

		describe('systemPromptContains', () => {
			test('matches when system prompt contains text', () => {
				const matcher = RequestMatchers.systemPromptContains('assistant')

				const matchingRequest = createRequest({
					systemPrompt: 'You are a helpful assistant.',
				})
				const nonMatchingRequest = createRequest({
					systemPrompt: 'You are a bot.',
				})

				expect(matcher(matchingRequest)).toBe(true)
				expect(matcher(nonMatchingRequest)).toBe(false)
			})
		})

		describe('hasTool', () => {
			test('matches when tool is available', () => {
				const matcher = RequestMatchers.hasTool('search')

				const matchingRequest = createRequest({
					tools: [
						{ name: 'search', description: 'Search for information', input: z.unknown(), execute: async () => ({ ok: true, value: '' }) },
					],
				})
				const nonMatchingRequest = createRequest({
					tools: [
						{ name: 'calculate', description: 'Do math', input: z.unknown(), execute: async () => ({ ok: true, value: '' }) },
					],
				})
				const noToolsRequest = createRequest({ tools: undefined })

				expect(matcher(matchingRequest)).toBe(true)
				expect(matcher(nonMatchingRequest)).toBe(false)
				expect(matcher(noToolsRequest)).toBe(false)
			})
		})

		describe('always', () => {
			test('always returns true', () => {
				const matcher = RequestMatchers.always()

				expect(matcher(createRequest())).toBe(true)
				expect(matcher(createRequest({ systemPrompt: 'anything' }))).toBe(true)
			})
		})
	})
})
