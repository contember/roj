/**
 * Token estimation utilities using tokenx library.
 * Provides ~95-98% accuracy compared to full tokenizers.
 */

import { estimateTokenCount, sliceByTokens } from 'tokenx'

/**
 * Estimate token count for a text string.
 * Uses tokenx library for better accuracy than simple char/4 heuristic.
 */
export function estimateTokens(text: string): number {
	return estimateTokenCount(text)
}

/**
 * Message structure for token estimation.
 */
export interface TokenEstimationMessage {
	role: string
	content: string | unknown
}

/**
 * Estimate total tokens for an array of messages.
 * Includes ~4 tokens overhead per message for role/formatting.
 */
export interface TruncationResult {
	content: string
	originalTokens: number
}

/**
 * Truncate text to fit within a token budget.
 * Returns null if text is already within budget.
 * Uses 80/20 head/tail split via sliceByTokens.
 */
export function truncateByTokens(text: string, maxTokens: number): TruncationResult | null {
	const originalTokens = estimateTokenCount(text)
	// 5% tolerance to avoid truncating near the boundary
	if (originalTokens <= maxTokens * 1.05) return null

	const headBudget = Math.floor(maxTokens * 0.8)
	const tailBudget = maxTokens - headBudget
	const head = sliceByTokens(text, 0, headBudget)
	const tail = sliceByTokens(text, -tailBudget)

	const content = `${head}\n\n[... truncated — ~${originalTokens} tokens total ...]\n\n${tail}`
	return { content, originalTokens }
}

/**
 * Estimate total tokens for an array of messages.
 * Includes ~4 tokens overhead per message for role/formatting.
 */
export function estimateMessagesTokens(messages: TokenEstimationMessage[]): number {
	return messages.reduce((sum, msg) => {
		const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
		return sum + estimateTokens(content) + 4 // 4 tokens overhead per message
	}, 0)
}
