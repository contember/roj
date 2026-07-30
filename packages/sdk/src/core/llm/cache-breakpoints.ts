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
 * `ttl` opts into Anthropic's 1-hour cache tier (write 2× input, read still
 * 0.1×) and applies to the **stable prefix breakpoint only** — the tail keeps
 * the default 5-minute tier.
 *
 * Applying a long TTL to both is a losing trade for an interactive agent. On a
 * measured 5-week production session, 95% of inferences followed a gap under
 * five minutes, so a uniform 1h would have raised the cost of every one of
 * those writes from 1.25× to 2× while fixing only the minority that actually
 * expired — a net loss. The prefix is the part that must survive human pauses;
 * the tail churns turn-to-turn and is cheapest on the short tier.
 *
 * Order matters: Anthropic requires a longer TTL to precede a shorter one, and
 * the prefix breakpoint always sits before the tail. Providers must also give
 * the system block the longest TTL in use, since it precedes both.
 */
export function applyCacheBreakpoint(
	messages: LLMMessage[],
	uncachedSuffixCount: number,
	ttl?: '5m' | '1h',
	cachedPrefixCount = 0,
): LLMMessage[] {
	const prefixCacheControl: LLMMessageCacheControl = ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' }
	const tailCacheControl: LLMMessageCacheControl = { type: 'ephemeral' }
	const result = [...messages]

	const mark = (idx: number, cacheControl: LLMMessageCacheControl) => {
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
	if (prefixIdx !== tailIdx) mark(prefixIdx, prefixCacheControl)
	// When the two coincide there is only one entry to pin, and it covers the
	// preamble — so it takes the prefix TTL.
	mark(tailIdx, prefixIdx === tailIdx ? prefixCacheControl : tailCacheControl)
	return result
}
