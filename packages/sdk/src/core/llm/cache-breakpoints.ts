import type { LLMMessage, LLMMessageCacheControl } from '~/core/agents/state.js'

/**
 * Mark the prompt cache breakpoint on a message list.
 *
 * Flag-based: the target message gets a `cacheControl` marker. Providers that
 * support ephemeral prompt caching (anthropic, openrouter) react to the flag
 * during `buildHttpRequest` and place `cache_control: { type: 'ephemeral' }`
 * on the LAST content block of the mapped message — regardless of block type
 * (text / tool_use / tool_result / image). This matches the API semantics
 * "cache the prefix up to and including this block".
 *
 * Target index is `messages.length - 1 - uncachedSuffixCount`. The suffix is
 * the tail of messages that must remain fresh (e.g. ephemeral session context
 * rebuilt each inference).
 *
 * `ttl` opts into Anthropic's 1-hour cache tier (write cost 2× input, read
 * still 0.1×). Useful for long-lived agents where the default 5-minute TTL
 * would expire between user turns. Omit for the default 5-minute tier.
 */
export function applyCacheBreakpoint(
	messages: LLMMessage[],
	uncachedSuffixCount: number,
	ttl?: '5m' | '1h',
): LLMMessage[] {
	const idx = messages.length - 1 - uncachedSuffixCount
	if (idx < 0) return messages

	const cacheControl: LLMMessageCacheControl = ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' }
	const target = messages[idx]
	const result = [...messages]
	switch (target.role) {
		case 'user':
			result[idx] = { ...target, cacheControl }
			break
		case 'assistant':
			result[idx] = { ...target, cacheControl }
			break
		case 'system':
			result[idx] = { ...target, cacheControl }
			break
		case 'tool':
			result[idx] = { ...target, cacheControl }
			break
	}
	return result
}
