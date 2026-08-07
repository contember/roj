import { describe, expect, test } from 'bun:test'
import type { LLMError } from '~/core/llm/provider.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { withLLMRetry, withRetry } from './retry.js'

const timeout: LLMError = { type: 'timeout', message: 'Request timed out' }

describe('withRetry abort handling', () => {
	test('a cancel after a retryable failure reports the cancel, not the failure', async () => {
		const controller = new AbortController()
		let attempts = 0

		const result = await withLLMRetry(
			async () => {
				attempts++
				// Cancel the way a shutdown does: while the request is in flight.
				controller.abort()
				return Err(timeout)
			},
			{ baseDelayMs: 1, maxDelayMs: 1, signal: controller.signal },
		)

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

		const result = await withLLMRetry(async () => {
			attempts++
			return attempts === 1 ? Err(timeout) : Ok('done')
		}, { baseDelayMs: 1, maxDelayMs: 1 })

		expect(attempts).toBe(2)
		expect(result).toEqual(Ok('done'))
	})
})
