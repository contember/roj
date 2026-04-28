/**
 * Client-specific domain utilities.
 */

import { estimateTokenCount } from 'tokenx'

/**
 * Estimate token count for a text string.
 */
export function estimateTokens(text: string): number {
	return estimateTokenCount(text)
}
