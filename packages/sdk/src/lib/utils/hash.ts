/**
 * Synchronous hash utilities for anti-looping fingerprinting.
 * Uses FNV-1a for fast, deterministic hashing in pure reducers.
 */

const FNV_OFFSET_BASIS = 2166136261
const FNV_PRIME = 16777619
const MAX_INPUT_LENGTH = 500

/**
 * FNV-1a 32-bit hash, returned as hex string.
 */
export function fnv1aHash(str: string): string {
	let hash = FNV_OFFSET_BASIS
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i)
		hash = Math.imul(hash, FNV_PRIME)
	}
	return (hash >>> 0).toString(16)
}

/**
 * Fingerprint a tool call as "toolName:hash(input)".
 * Input is JSON-stringified and truncated to 500 chars before hashing.
 */
export function toolCallFingerprint(toolName: string, input: unknown): string {
	const inputStr = JSON.stringify(input ?? null).slice(0, MAX_INPUT_LENGTH)
	return `${toolName}:${fnv1aHash(inputStr)}`
}

/**
 * Fingerprint a text response.
 * Content is truncated to 500 chars before hashing.
 */
export function responseFingerprint(content: string | null): string {
	const str = (content ?? '').slice(0, MAX_INPUT_LENGTH)
	return fnv1aHash(str)
}
