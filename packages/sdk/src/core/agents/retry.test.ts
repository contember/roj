import { describe, expect, jest, spyOn, test } from 'bun:test'
import type { LLMError } from '~/core/llm/provider.js'
import type { Logger } from '~/lib/logger/logger.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { withLLMRetry, withRetry } from './retry.js'

const timeout: LLMError = { type: 'timeout', message: 'Request timed out' }

describe('withRetry abort handling', () => {
	test('a cancel after a retryable failure reports the cancel, not the failure', async () => {
		const controller = new AbortController()
		const listenerSpy = spyOn(controller.signal, 'addEventListener')
		let attempts = 0

		const resultPromise = withLLMRetry(
			async () => {
				attempts++
				return Err(timeout)
			},
			{ baseDelayMs: 60_000, maxDelayMs: 60_000, signal: controller.signal },
		)
		await Promise.resolve()
		expect(listenerSpy).toHaveBeenCalledTimes(1)

		controller.abort()
		const result = await resultPromise

		expect(attempts).toBe(1)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.type).toBe('aborted')
	})

	test('a cancel before the first attempt reports the cancel', async () => {
		const controller = new AbortController()
		controller.abort()
		let attempts = 0

		const result = await withLLMRetry(
			async () => {
				attempts++
				return Err(timeout)
			},
			{ signal: controller.signal },
		)

		expect(attempts).toBe(0)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.type).toBe('aborted')
	})

	test('without a cancel the last error still surfaces after maxAttempts', async () => {
		let attempts = 0

		const result = await withLLMRetry(
			async () => {
				attempts++
				return Err(timeout)
			},
			{ maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
		)

		expect(attempts).toBe(3)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.type).toBe('timeout')
	})

	test('the final failed attempt neither calculates nor logs another retry', async () => {
		jest.useFakeTimers()
		let retryDelayReads = 0
		let retryWarnings = 0
		const logger: Logger = {
			debug: () => {},
			info: () => {},
			warn: () => {
				retryWarnings++
			},
			error: () => {},
			child: () => logger,
			level: 'debug',
		}

		try {
			const resultPromise = withRetry<string, string>(async () => Err('exhausted'), {
				isRetryable: () => true,
				getRetryDelay: () => {
					retryDelayReads++
					return 60_000
				},
				maxAttempts: 1,
				logger,
			})
			await Promise.resolve()

			expect(retryDelayReads).toBe(0)
			expect(retryWarnings).toBe(0)
			expect(jest.getTimerCount()).toBe(0)
			expect(await resultPromise).toEqual(Err('exhausted'))
		} finally {
			jest.useRealTimers()
		}
	})

	test('a cancel coincident with the final failure returns the abort error', async () => {
		const controller = new AbortController()

		const result = await withRetry<string, string>(
			async () => {
				controller.abort()
				return Err('transient')
			},
			{
				isRetryable: () => true,
				maxAttempts: 1,
				signal: controller.signal,
				abortError: 'cancelled',
			},
		)

		expect(result).toEqual(Err('cancelled'))
	})

	test('a cancel with no abortError configured still falls back to the last error', async () => {
		const controller = new AbortController()

		const result = await withRetry<string, string>(
			async () => {
				controller.abort()
				return Err('transient')
			},
			{ isRetryable: () => true, baseDelayMs: 1, maxDelayMs: 1, signal: controller.signal },
		)

		expect(result).toEqual(Err('transient'))
	})

	test('success short-circuits the retry loop', async () => {
		let attempts = 0

		const result = await withLLMRetry(
			async () => {
				attempts++
				return attempts === 1 ? Err(timeout) : Ok('done')
			},
			{ baseDelayMs: 1, maxDelayMs: 1 },
		)

		expect(attempts).toBe(2)
		expect(result).toEqual(Ok('done'))
	})
})
