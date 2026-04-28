import type { LLMError } from '~/core/llm/provider.js'
import type { Result } from '~/lib/utils/result.js'
import { Err } from '~/lib/utils/result.js'
import type { Logger } from '../../lib/logger/logger.js'

// ============================================================================
// Retry Options
// ============================================================================

export interface RetryOptions {
	maxAttempts?: number
	baseDelayMs?: number
	maxDelayMs?: number
}

export const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
	maxAttempts: 5,
	baseDelayMs: 1000,
	maxDelayMs: 60000,
}

// ============================================================================
// Generic Retry Helper
// ============================================================================

export interface WithRetryOptions<E> extends RetryOptions {
	isRetryable: (error: E) => boolean
	getRetryDelay?: (error: E) => number | undefined
	/** Error to return when aborted before first attempt */
	abortError?: E
	logger?: Logger
	context?: string
	signal?: AbortSignal
}

/**
 * Generic retry wrapper with exponential backoff.
 */
export async function withRetry<T, E>(
	fn: () => Promise<Result<T, E>>,
	options: WithRetryOptions<E>,
): Promise<Result<T, E>> {
	const opts = {
		maxAttempts: options.maxAttempts ?? DEFAULT_RETRY_OPTIONS.maxAttempts,
		baseDelayMs: options.baseDelayMs ?? DEFAULT_RETRY_OPTIONS.baseDelayMs,
		maxDelayMs: options.maxDelayMs ?? DEFAULT_RETRY_OPTIONS.maxDelayMs,
	}

	let attempt = 0
	let lastError: E | null = null

	while (attempt < opts.maxAttempts) {
		if (options.signal?.aborted) {
			const error = lastError ?? options.abortError
			if (error !== undefined) {
				return Err(error)
			}
			break
		}

		const result = await fn()

		if (result.ok) {
			if (attempt > 0 && options.logger) {
				options.logger.info('Operation succeeded after retries', {
					context: options.context,
					attempt: attempt + 1,
				})
			}
			return result
		}

		lastError = result.error

		if (!options.isRetryable(lastError)) {
			return result
		}

		attempt++
		const delay = calculateDelay(attempt, lastError, opts, options.getRetryDelay)

		if (options.logger) {
			options.logger.warn('Operation failed, retrying', {
				context: options.context,
				attempt,
				delayMs: delay,
			})
		}

		await sleep(delay, options.signal)
	}

	return Err(lastError!)
}

function calculateDelay<E>(
	attempt: number,
	error: E,
	opts: Required<RetryOptions>,
	getRetryDelay?: (error: E) => number | undefined,
): number {
	// Use error-specific delay if available
	const errorDelay = getRetryDelay?.(error)
	if (errorDelay !== undefined) {
		return Math.min(errorDelay, opts.maxDelayMs)
	}

	// Exponential backoff: baseDelay * 2^(attempt-1)
	const exponentialDelay = opts.baseDelayMs * Math.pow(2, attempt - 1)

	// Add jitter (0-30%) to prevent thundering herd
	const jitter = Math.random() * 0.3 * exponentialDelay

	return Math.min(exponentialDelay + jitter, opts.maxDelayMs)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve()
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms)
		signal?.addEventListener('abort', () => {
			clearTimeout(timer)
			resolve()
		}, { once: true })
	})
}

// ============================================================================
// LLM-specific helpers
// ============================================================================

/**
 * Determines if an LLM error is retryable.
 * Retryable: rate_limit, server_error, network_error, timeout
 * Non-retryable: invalid_request, context_length (permanent failures)
 */
export function isRetryableLLMError(error: LLMError): boolean {
	return ['rate_limit', 'server_error', 'network_error', 'timeout'].includes(
		error.type,
	)
}

/**
 * Gets retry delay from LLM error if available (e.g., rate limit retry-after).
 */
export function getLLMRetryDelay(error: LLMError): number | undefined {
	return error.retryAfterMs
}

/**
 * Convenience wrapper for LLM inference with retry.
 */
export async function withLLMRetry<T>(
	fn: () => Promise<Result<T, LLMError>>,
	options?: RetryOptions & { logger?: Logger; signal?: AbortSignal },
): Promise<Result<T, LLMError>> {
	return withRetry(fn, {
		...options,
		isRetryable: isRetryableLLMError,
		getRetryDelay: getLLMRetryDelay,
		abortError: { type: 'aborted', message: 'Aborted before first attempt' },
		context: 'LLM inference',
	})
}
