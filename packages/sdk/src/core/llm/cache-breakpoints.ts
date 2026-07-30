import type { LLMMessage, LLMMessageCacheControl } from '~/core/agents/state.js'

/** Anthropic's two ephemeral cache tiers: 5-minute (write 1.25×) and 1-hour (write 2×). Reads are 0.1× on both. */
export type CacheTtl = '5m' | '1h'

/**
 * Per-breakpoint prompt cache TTL.
 *
 * A bare tier applies to both breakpoints. The object form sets them
 * independently, which is usually what you want: the stable prefix and the
 * churning conversation tail have opposite cost profiles.
 *
 * Choosing between them is an economic question about a specific agent's call
 * pattern, so the SDK does not pick for you:
 *
 * - A long TTL on the **prefix** pays off when calls are spread further apart
 *   than the short tier survives — an orchestrator waiting on a human.
 * - A long TTL on the **tail** costs 2× on every write while the tail is
 *   rewritten turn-to-turn anyway, so it only pays when consecutive calls are
 *   themselves minutes apart.
 *
 * Worked example, from a measured 5-week production session: 95% of inferences
 * followed a sub-5-minute gap, so `'1h'` uniformly came out ~2.5% *worse* than
 * the default, while `{ prefix: '1h' }` targeted the 29 rewrites that actually
 * expired. A batch agent called in a tight loop would want the opposite.
 *
 * Constraint: Anthropic requires a longer TTL to precede a shorter one, and the
 * prefix breakpoint always sits before the tail. So `{ prefix: '5m', tail: '1h' }`
 * is invalid at the API and will be rejected — the tail TTL must not exceed the
 * prefix TTL.
 */
export type CacheTtlConfig = CacheTtl | { prefix?: CacheTtl; tail?: CacheTtl }

const resolveTtls = (config: CacheTtlConfig | undefined): { prefix?: CacheTtl; tail?: CacheTtl } => {
	if (config === undefined) return {}
	if (typeof config === 'string') return { prefix: config, tail: config }
	return config
}

const cacheControl = (ttl: CacheTtl | undefined): LLMMessageCacheControl => ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' }

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
 * If the prefix and tail indices coincide, only one breakpoint is set — it
 * covers the preamble, so it takes the prefix TTL.
 *
 * `ttl` sets the cache tier per breakpoint; see {@link CacheTtlConfig} for how
 * to choose. Providers must additionally give the system block the longest TTL
 * in use, since it precedes every message and Anthropic rejects a longer entry
 * that follows a shorter one.
 */
export function applyCacheBreakpoint(
	messages: LLMMessage[],
	uncachedSuffixCount: number,
	ttl?: CacheTtlConfig,
	cachedPrefixCount = 0,
): LLMMessage[] {
	const ttls = resolveTtls(ttl)
	const prefixCacheControl = cacheControl(ttls.prefix)
	const tailCacheControl = cacheControl(ttls.tail)
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
