/**
 * Result type for explicit error handling without exceptions.
 * Inspired by Rust/Go approach.
 */

export type Result<T, E = Error> =
	| { ok: true; value: T }
	| { ok: false; error: E }

// Constructors
export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error })

// Type guards
export const isOk = <T, E>(result: Result<T, E>): result is { ok: true; value: T } => result.ok
export const isErr = <T, E>(result: Result<T, E>): result is { ok: false; error: E } => !result.ok

// Helper functions
export const mapResult = <T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => U,
): Result<U, E> => result.ok ? Ok(fn(result.value)) : result

export const flatMapResult = <T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => Result<U, E>,
): Result<U, E> => result.ok ? fn(result.value) : result

// Unwrap functions
export const unwrapOr = <T, E>(result: Result<T, E>, defaultValue: T): T => result.ok ? result.value : defaultValue

export const unwrapOrThrow = <T, E>(result: Result<T, E>): T => {
	if (result.ok) return result.value
	throw result.error
}
