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

	test('ttl applies to the stable prefix only — the tail keeps the 5m default', () => {
		// A uniform long TTL is a losing trade: on a measured production session 95%
		// of inferences followed a sub-5-minute gap, so paying 2× on every tail write
		// to rescue the expiring minority came out net negative.
		const messages = userMessages(6)
		const result = applyCacheBreakpoint(messages, 0, '1h', 2)
		// prefix = 1, tail = 5
		const prefix = result[1]
		const tail = result[5]
		expect('cacheControl' in prefix && prefix.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
		expect('cacheControl' in tail && tail.cacheControl).toEqual({ type: 'ephemeral' })
	})

	test('prefixIdx === tailIdx with a ttl → the single mark covers the preamble, so it takes the ttl', () => {
		const messages = userMessages(3)
		const result = applyCacheBreakpoint(messages, 0, '1h', 3)
		expect(cachedIndices(result)).toEqual([2])
		const only = result[2]
		expect('cacheControl' in only && only.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
	})

	test('no ttl → neither breakpoint carries one', () => {
		const messages = userMessages(6)
		const result = applyCacheBreakpoint(messages, 0, undefined, 2)
		for (const idx of [1, 5]) {
			const m = result[idx]
			expect('cacheControl' in m && m.cacheControl).toEqual({ type: 'ephemeral' })
		}
	})

	test('does not mutate the input array', () => {
		const messages = userMessages(5)
		applyCacheBreakpoint(messages, 0, undefined, 2)
		expect(cachedIndices(messages)).toEqual([])
	})
})
