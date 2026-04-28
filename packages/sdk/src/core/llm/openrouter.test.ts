import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Logger } from '~/lib/logger/logger.js'
import { Err, isErr, isOk, Ok } from '~/lib/utils/result.js'
import type { InferenceRequest, InferenceResponse, LLMError } from './provider.js'
import { ModelId } from './schema.js'

// ============================================================================
// RetryableLLMProviderStub - Testable implementation of retry logic
// ============================================================================

// We test the retry logic by creating a minimal testable stub that implements
// the same logic as OpenRouterProvider but without the OpenAI dependency.
// This allows us to test retry behavior without network calls.

interface RetryOptions {
	maxAttempts?: number
	baseDelayMs?: number
	maxDelayMs?: number
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
	maxAttempts: Infinity,
	baseDelayMs: 1000,
	maxDelayMs: 60000,
}

type InferenceResult = {
	ok: true
	value: InferenceResponse
} | {
	ok: false
	error: LLMError
}

class RetryableLLMProviderStub {
	readonly name = 'retry-stub'
	private logger: Logger | null
	private inferenceHandler: () => Promise<InferenceResult>
	private sleepMs: number[] = []

	constructor(
		inferenceHandler: () => Promise<InferenceResult>,
		logger?: Logger,
	) {
		this.inferenceHandler = inferenceHandler
		this.logger = logger ?? null
	}

	getSleepHistory(): number[] {
		return [...this.sleepMs]
	}

	async inference(
		_request: InferenceRequest,
	): Promise<InferenceResult> {
		return this.inferenceHandler()
	}

	async inferenceWithRetry(
		request: InferenceRequest,
		options?: RetryOptions,
	): Promise<InferenceResult> {
		const opts = { ...DEFAULT_RETRY_OPTIONS, ...options }
		let attempt = 0
		let lastError: LLMError | null = null

		while (attempt < opts.maxAttempts) {
			const result = await this.inference(request)

			if (result.ok) {
				return result
			}

			lastError = result.error

			if (!this.isRetryableError(lastError)) {
				return result
			}

			attempt++
			const delay = this.calculateDelay(attempt, lastError, opts)

			this.logger?.warn('LLM inference failed, retrying', {
				attempt,
				errorType: lastError.type,
				errorMessage: lastError.message,
				delayMs: delay,
			})

			await this.sleep(delay)
		}

		return Err(lastError!)
	}

	private isRetryableError(error: LLMError): boolean {
		return ['rate_limit', 'server_error', 'network_error', 'timeout'].includes(
			error.type,
		)
	}

	// Exposed for testing - uses deterministic calculation without jitter
	calculateDelayForTest(
		attempt: number,
		error: LLMError,
		opts: Required<RetryOptions>,
	): number {
		if (error.retryAfterMs) {
			return Math.min(error.retryAfterMs, opts.maxDelayMs)
		}
		const exponentialDelay = opts.baseDelayMs * Math.pow(2, attempt - 1)
		return Math.min(exponentialDelay, opts.maxDelayMs)
	}

	private calculateDelay(
		attempt: number,
		error: LLMError,
		opts: Required<RetryOptions>,
	): number {
		if (error.retryAfterMs) {
			return Math.min(error.retryAfterMs, opts.maxDelayMs)
		}

		const exponentialDelay = opts.baseDelayMs * Math.pow(2, attempt - 1)
		const jitter = Math.random() * 0.3 * exponentialDelay
		return Math.min(exponentialDelay + jitter, opts.maxDelayMs)
	}

	private async sleep(ms: number): Promise<void> {
		this.sleepMs.push(ms)
		// Don't actually sleep in tests
	}
}

// ============================================================================
// Test helpers
// ============================================================================

const createRequest = (
	overrides: Partial<InferenceRequest> = {},
): InferenceRequest => ({
	model: ModelId('test-model'),
	systemPrompt: 'You are a test assistant.',
	messages: [{ role: 'user', content: 'Hello' }],
	...overrides,
})

const createSuccessResponse = (
	content = 'Success',
): InferenceResponse => ({
	content,
	toolCalls: [],
	finishReason: 'stop',
	metrics: {
		promptTokens: 10,
		completionTokens: 5,
		totalTokens: 15,
		latencyMs: 100,
		model: 'test-model',
	},
})

// ============================================================================
// Tests
// ============================================================================

describe('Retry Logic', () => {
	describe('isRetryableError', () => {
		test('rate_limit is retryable', async () => {
			let callCount = 0
			const provider = new RetryableLLMProviderStub(async () => {
				callCount++
				if (callCount < 2) {
					return Err({ type: 'rate_limit', message: 'Rate limit exceeded' })
				}
				return Ok(createSuccessResponse())
			})

			const result = await provider.inferenceWithRetry(createRequest(), {
				maxAttempts: 3,
			})

			expect(isOk(result)).toBe(true)
			expect(callCount).toBe(2)
		})

		test('server_error is retryable', async () => {
			let callCount = 0
			const provider = new RetryableLLMProviderStub(async () => {
				callCount++
				if (callCount < 2) {
					return Err({ type: 'server_error', message: 'Internal server error' })
				}
				return Ok(createSuccessResponse())
			})

			const result = await provider.inferenceWithRetry(createRequest(), {
				maxAttempts: 3,
			})

			expect(isOk(result)).toBe(true)
			expect(callCount).toBe(2)
		})

		test('network_error is retryable', async () => {
			let callCount = 0
			const provider = new RetryableLLMProviderStub(async () => {
				callCount++
				if (callCount < 2) {
					return Err({ type: 'network_error', message: 'Connection failed' })
				}
				return Ok(createSuccessResponse())
			})

			const result = await provider.inferenceWithRetry(createRequest(), {
				maxAttempts: 3,
			})

			expect(isOk(result)).toBe(true)
			expect(callCount).toBe(2)
		})

		test('timeout is retryable', async () => {
			let callCount = 0
			const provider = new RetryableLLMProviderStub(async () => {
				callCount++
				if (callCount < 2) {
					return Err({ type: 'timeout', message: 'Request timed out' })
				}
				return Ok(createSuccessResponse())
			})

			const result = await provider.inferenceWithRetry(createRequest(), {
				maxAttempts: 3,
			})

			expect(isOk(result)).toBe(true)
			expect(callCount).toBe(2)
		})

		test('invalid_request is NOT retryable', async () => {
			let callCount = 0
			const provider = new RetryableLLMProviderStub(async () => {
				callCount++
				return Err({ type: 'invalid_request', message: 'Bad request' })
			})

			const result = await provider.inferenceWithRetry(createRequest(), {
				maxAttempts: 3,
			})

			expect(isErr(result)).toBe(true)
			expect(callCount).toBe(1) // No retry
			if (isErr(result)) {
				expect(result.error.type).toBe('invalid_request')
			}
		})

		test('context_length is NOT retryable', async () => {
			let callCount = 0
			const provider = new RetryableLLMProviderStub(async () => {
				callCount++
				return Err({ type: 'context_length', message: 'Context too long' })
			})

			const result = await provider.inferenceWithRetry(createRequest(), {
				maxAttempts: 3,
			})

			expect(isErr(result)).toBe(true)
			expect(callCount).toBe(1) // No retry
			if (isErr(result)) {
				expect(result.error.type).toBe('context_length')
			}
		})
	})

	describe('success on first attempt', () => {
		test('returns immediately without retry', async () => {
			let callCount = 0
			const provider = new RetryableLLMProviderStub(async () => {
				callCount++
				return Ok(createSuccessResponse('First attempt success'))
			})

			const result = await provider.inferenceWithRetry(createRequest())

			expect(isOk(result)).toBe(true)
			expect(callCount).toBe(1)
			expect(provider.getSleepHistory()).toHaveLength(0)
			if (isOk(result)) {
				expect(result.value.content).toBe('First attempt success')
			}
		})
	})

	describe('retry options', () => {
		test('respects maxAttempts limit', async () => {
			let callCount = 0
			const provider = new RetryableLLMProviderStub(async () => {
				callCount++
				return Err({ type: 'rate_limit', message: 'Rate limit exceeded' })
			})

			const result = await provider.inferenceWithRetry(createRequest(), {
				maxAttempts: 3,
			})

			expect(isErr(result)).toBe(true)
			expect(callCount).toBe(3)
			if (isErr(result)) {
				expect(result.error.type).toBe('rate_limit')
			}
		})

		test('succeeds after multiple retries', async () => {
			let callCount = 0
			const provider = new RetryableLLMProviderStub(async () => {
				callCount++
				if (callCount < 3) {
					return Err({ type: 'server_error', message: 'Server error' })
				}
				return Ok(createSuccessResponse('Third attempt success'))
			})

			const result = await provider.inferenceWithRetry(createRequest(), {
				maxAttempts: 5,
			})

			expect(isOk(result)).toBe(true)
			expect(callCount).toBe(3)
			if (isOk(result)) {
				expect(result.value.content).toBe('Third attempt success')
			}
		})
	})

	describe('exponential backoff', () => {
		test('calculates exponential delays', () => {
			const provider = new RetryableLLMProviderStub(async () => Ok(createSuccessResponse()))
			const opts: Required<RetryOptions> = {
				maxAttempts: 10,
				baseDelayMs: 1000,
				maxDelayMs: 60000,
			}
			const error: LLMError = { type: 'rate_limit', message: 'Rate limit' }

			// attempt 1: 1000 * 2^0 = 1000
			expect(provider.calculateDelayForTest(1, error, opts)).toBe(1000)

			// attempt 2: 1000 * 2^1 = 2000
			expect(provider.calculateDelayForTest(2, error, opts)).toBe(2000)

			// attempt 3: 1000 * 2^2 = 4000
			expect(provider.calculateDelayForTest(3, error, opts)).toBe(4000)

			// attempt 4: 1000 * 2^3 = 8000
			expect(provider.calculateDelayForTest(4, error, opts)).toBe(8000)

			// attempt 5: 1000 * 2^4 = 16000
			expect(provider.calculateDelayForTest(5, error, opts)).toBe(16000)
		})

		test('respects maxDelayMs cap', () => {
			const provider = new RetryableLLMProviderStub(async () => Ok(createSuccessResponse()))
			const opts: Required<RetryOptions> = {
				maxAttempts: 10,
				baseDelayMs: 1000,
				maxDelayMs: 10000,
			}
			const error: LLMError = { type: 'rate_limit', message: 'Rate limit' }

			// attempt 5: 1000 * 2^4 = 16000, but capped at 10000
			expect(provider.calculateDelayForTest(5, error, opts)).toBe(10000)

			// attempt 10: would be huge, but capped at 10000
			expect(provider.calculateDelayForTest(10, error, opts)).toBe(10000)
		})

		test('uses retry-after header when available', () => {
			const provider = new RetryableLLMProviderStub(async () => Ok(createSuccessResponse()))
			const opts: Required<RetryOptions> = {
				maxAttempts: 10,
				baseDelayMs: 1000,
				maxDelayMs: 60000,
			}
			const error: LLMError = {
				type: 'rate_limit',
				message: 'Rate limit',
				retryAfterMs: 5000,
			}

			// Should use retry-after value
			expect(provider.calculateDelayForTest(1, error, opts)).toBe(5000)
			expect(provider.calculateDelayForTest(5, error, opts)).toBe(5000)
		})

		test('caps retry-after at maxDelayMs', () => {
			const provider = new RetryableLLMProviderStub(async () => Ok(createSuccessResponse()))
			const opts: Required<RetryOptions> = {
				maxAttempts: 10,
				baseDelayMs: 1000,
				maxDelayMs: 30000,
			}
			const error: LLMError = {
				type: 'rate_limit',
				message: 'Rate limit',
				retryAfterMs: 120000, // 2 minutes
			}

			// Should be capped at maxDelayMs
			expect(provider.calculateDelayForTest(1, error, opts)).toBe(30000)
		})
	})

	describe('logging', () => {
		test('logs retry attempts', async () => {
			const warnCalls: unknown[] = []
			const mockLogger: Logger = {
				level: 'debug',
				info: () => {},
				warn: (...args: unknown[]) => {
					warnCalls.push(args)
				},
				error: () => {},
				debug: () => {},
				child: () => mockLogger,
			}

			let callCount = 0
			const provider = new RetryableLLMProviderStub(
				async () => {
					callCount++
					if (callCount < 3) {
						return Err({ type: 'rate_limit', message: 'Rate limit exceeded' })
					}
					return Ok(createSuccessResponse())
				},
				mockLogger,
			)

			await provider.inferenceWithRetry(createRequest(), { maxAttempts: 5 })

			expect(warnCalls).toHaveLength(2) // 2 retries before success
			expect(warnCalls[0]).toContain('LLM inference failed, retrying')
		})
	})

	describe('default retry options', () => {
		test('uses default values when options not provided', async () => {
			let callCount = 0
			const provider = new RetryableLLMProviderStub(async () => {
				callCount++
				if (callCount < 2) {
					return Err({ type: 'network_error', message: 'Network error' })
				}
				return Ok(createSuccessResponse())
			})

			const result = await provider.inferenceWithRetry(createRequest())

			expect(isOk(result)).toBe(true)
			expect(callCount).toBe(2)

			// Check that sleep was called with approximately baseDelayMs (1000) + jitter
			const sleepHistory = provider.getSleepHistory()
			expect(sleepHistory).toHaveLength(1)
			expect(sleepHistory[0]).toBeGreaterThanOrEqual(1000)
			expect(sleepHistory[0]).toBeLessThanOrEqual(1300) // 1000 + 30% jitter
		})
	})

	describe('mixed error types', () => {
		test('retries retryable errors then stops on non-retryable', async () => {
			let callCount = 0
			const provider = new RetryableLLMProviderStub(async () => {
				callCount++
				if (callCount === 1) {
					return Err({ type: 'rate_limit', message: 'Rate limit' })
				}
				if (callCount === 2) {
					return Err({ type: 'network_error', message: 'Network error' })
				}
				// Third call returns non-retryable error
				return Err({ type: 'invalid_request', message: 'Bad request' })
			})

			const result = await provider.inferenceWithRetry(createRequest(), {
				maxAttempts: 10,
			})

			expect(isErr(result)).toBe(true)
			expect(callCount).toBe(3)
			if (isErr(result)) {
				expect(result.error.type).toBe('invalid_request')
			}
		})
	})
})
