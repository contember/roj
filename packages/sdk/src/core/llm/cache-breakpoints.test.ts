import { describe, expect, test } from 'bun:test'
import type { LLMMessage } from '~/core/agents/state.js'
import { applyCacheBreakpoint } from './cache-breakpoints.js'

const userMessages = (count: number): LLMMessage[] =>
	Array.from({ length: count }, (_, i) => ({ role: 'user', content: `m${i}` }))

const cachedIndices = (messages: LLMMessage[]): number[] =>
	messages.flatMap((m, i) => ('cacheControl' in m && m.cacheControl ? [i] : []))

describe('applyCacheBreakpoint', () => {
	test('cachedPrefixCount = 0 → single tail breakpoint only (unchanged behaviour)', () => {
		const messages = userMessages(5)
		const result = applyCacheBreakpoint(messages, 1)
		// tail = length - 1 - suffix = 5 - 1 - 1 = 3
		expect(cachedIndices(result)).toEqual([3])
	})

	test('cachedPrefixCount > 0 → two breakpoints: prefix end and tail', () => {
		const messages = userMessages(10)
		const result = applyCacheBreakpoint(messages, 1, undefined, 3)
		// prefix = 3 - 1 = 2, tail = 10 - 1 - 1 = 8
		expect(cachedIndices(result)).toEqual([2, 8])
	})

	test('prefixIdx === tailIdx → only one breakpoint, no duplicate', () => {
		// preamble is the whole list, no suffix: tail = 3 - 1 - 0 = 2, prefix = 3 - 1 = 2
		const messages = userMessages(3)
		const result = applyCacheBreakpoint(messages, 0, undefined, 3)
		expect(cachedIndices(result)).toEqual([2])
	})

	test('cachedPrefixCount larger than messages.length → out-of-range prefix ignored, tail still applied', () => {
		const messages = userMessages(4)
		const result = applyCacheBreakpoint(messages, 0, undefined, 99)
		// prefix = 98 (out of range, ignored), tail = 4 - 1 - 0 = 3
		expect(cachedIndices(result)).toEqual([3])
	})

	// prefix = 1, tail = 5 for userMessages(6) with suffix 0 and cachedPrefixCount 2
	const ttlsOf = (messages: LLMMessage[]) => [1, 5].map((idx) => {
		const m = messages[idx]
		return 'cacheControl' in m && m.cacheControl ? m.cacheControl.ttl : undefined
	})

	test('a bare tier applies to both breakpoints', () => {
		const result = applyCacheBreakpoint(userMessages(6), 0, '1h', 2)
		expect(ttlsOf(result)).toEqual(['1h', '1h'])
	})

	test('{ prefix } leaves the tail on the default tier', () => {
		// Usually the paying configuration for an interactive agent: the immutable
		// preamble survives human pauses, the churning tail stays cheap to write.
		const result = applyCacheBreakpoint(userMessages(6), 0, { prefix: '1h' }, 2)
		expect(ttlsOf(result)).toEqual(['1h', undefined])
	})

	test('{ prefix, tail } sets each breakpoint independently', () => {
		const result = applyCacheBreakpoint(userMessages(6), 0, { prefix: '1h', tail: '5m' }, 2)
		expect(ttlsOf(result)).toEqual(['1h', '5m'])
	})

	test('{ tail } alone is honoured — the SDK does not second-guess the caller', () => {
		const result = applyCacheBreakpoint(userMessages(6), 0, { tail: '1h' }, 2)
		expect(ttlsOf(result)).toEqual([undefined, '1h'])
	})

	test('prefixIdx === tailIdx → the single mark covers the preamble, so it takes the prefix ttl', () => {
		const result = applyCacheBreakpoint(userMessages(3), 0, { prefix: '1h' }, 3)
		expect(cachedIndices(result)).toEqual([2])
		const only = result[2]
		expect('cacheControl' in only && only.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
	})

	test('no ttl → neither breakpoint carries one', () => {
		const result = applyCacheBreakpoint(userMessages(6), 0, undefined, 2)
		expect(ttlsOf(result)).toEqual([undefined, undefined])
	})

	test('does not mutate the input array', () => {
		const messages = userMessages(5)
		applyCacheBreakpoint(messages, 0, undefined, 2)
		expect(cachedIndices(messages)).toEqual([])
	})
})
