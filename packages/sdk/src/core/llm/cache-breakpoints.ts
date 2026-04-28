import type { LLMMessage } from '~/core/agents/state.js'

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
 */
export function applyCacheBreakpoint(messages: LLMMessage[], uncachedSuffixCount: number): LLMMessage[] {
	const idx = messages.length - 1 - uncachedSuffixCount
	if (idx < 0) return messages

	const target = messages[idx]
	const result = [...messages]
	switch (target.role) {
		case 'user':
			result[idx] = { ...target, cacheControl: { type: 'ephemeral' } }
			break
		case 'assistant':
			result[idx] = { ...target, cacheControl: { type: 'ephemeral' } }
			break
		case 'system':
			result[idx] = { ...target, cacheControl: { type: 'ephemeral' } }
			break
		case 'tool':
			result[idx] = { ...target, cacheControl: { type: 'ephemeral' } }
			break
	}
	return result
}
