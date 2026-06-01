import type { LLMMessage, LLMMessageCacheControl } from '~/core/agents/state.js'

/**
 * Mark the prompt cache breakpoints on a message list.
 *
 * Flag-based: the target message gets a `cacheControl` marker. Providers that
 * support ephemeral prompt caching (anthropic, openrouter) react to the flag
 * during `buildHttpRequest` and place `cache_control: { type: 'ephemeral' }`
 * on the LAST content block of the mapped message — regardless of block type
 * (text / tool_use / tool_result / image). This matches the API semantics
 * "cache the prefix up to and including this block".
 *
 * Up to two breakpoints are set:
 *
 * 1. **Tail breakpoint** at `messages.length - 1 - uncachedSuffixCount`. The
 *    suffix is the tail of messages that must remain fresh (e.g. ephemeral
 *    session context rebuilt each inference).
 *
 * 2. **Stable prefix breakpoint** at `cachedPrefixCount - 1` (the last preamble
 *    message), set only when `cachedPrefixCount > 0`. The preamble is byte-
 *    identical on every call, but the prefix before the tail breakpoint churns
 *    turn-to-turn for compacting agents (regenerated summary, sliding recent
 *    window), so the tail breakpoint never produces a stable cache entry for
 *    the large immutable preamble. Pinning a second breakpoint at the end of
 *    the preamble lets Anthropic cache that prefix once and read it at 0.1× on
 *    every inference AND compaction call. Anthropic allows up to 4 breakpoints
 *    and matches the longest cached prefix, so the two coexist.
 *
 * If the prefix and tail indices coincide, only one breakpoint is set.
 *
 * `ttl` opts into Anthropic's 1-hour cache tier (write cost 2× input, read
 * still 0.1×). Useful for long-lived agents where the default 5-minute TTL
 * would expire between user turns. Omit for the default 5-minute tier.
 */
export function applyCacheBreakpoint(
	messages: LLMMessage[],
	uncachedSuffixCount: number,
	ttl?: '5m' | '1h',
	cachedPrefixCount = 0,
): LLMMessage[] {
	const cacheControl: LLMMessageCacheControl = ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' }
	const result = [...messages]

	const mark = (idx: number) => {
		if (idx < 0 || idx >= result.length) return
		const target = result[idx]
		switch (target.role) {
			case 'user':
			case 'assistant':
			case 'system':
			case 'tool':
				result[idx] = { ...target, cacheControl }
		}
	}

	const tailIdx = messages.length - 1 - uncachedSuffixCount
	// Stable prefix breakpoint at the last preamble message. Pins a cache entry
	// that survives turn-to-turn churn in the conversation tail (regenerated
	// summary, sliding recent window), so the immutable preamble is read at 0.1×
	// on every inference AND compaction call instead of being re-billed each turn.
	const prefixIdx = cachedPrefixCount - 1
	if (prefixIdx !== tailIdx) mark(prefixIdx)
	mark(tailIdx)
	return result
}
