/**
 * Response sanitization utilities for LLM outputs.
 *
 * Prevents hallucination by:
 * - Truncating at <message tags (system-generated only)
 * - Truncating after WAITING signal
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Result of sanitizing an LLM response.
 */
export interface SanitizedResponse {
	/** Sanitized content (truncated at message tags, WAITING) */
	content: string | null
	/** Whether the response was truncated */
	wasTruncated: boolean
}

// ============================================================================
// Sanitization
// ============================================================================

/**
 * Sanitize LLM response content to prevent hallucination.
 * - Truncates at any `<message` tag (LLM should not generate these)
 * - Truncates content after `WAITING` signal
 *
 * @param content - Raw LLM response content
 */
export function sanitizeLLMResponse(
	content: string | null,
): SanitizedResponse {
	if (content === null) {
		return { content: null, wasTruncated: false }
	}

	let result = content
	let wasTruncated = false

	// 1. Truncate at any <message tag (hallucination prevention)
	const messageTagIndex = result.indexOf('<message')
	if (messageTagIndex !== -1) {
		result = result.slice(0, messageTagIndex).trimEnd()
		wasTruncated = true
	}

	// 2. Truncate content after WAITING signal (on its own line)
	// WAITING means "I'm done, waiting for response" - anything after is likely hallucination
	const waitingMatch = result.match(/\n\s*WAITING\s*(?:\n|$)/)
	if (waitingMatch && waitingMatch.index !== undefined) {
		const endOfWaiting = waitingMatch.index + waitingMatch[0].length
		const contentAfterWaiting = result.slice(endOfWaiting).trim()
		if (contentAfterWaiting.length > 0) {
			result = result.slice(0, endOfWaiting).trimEnd()
			wasTruncated = true
		}
	}

	return {
		content: result || null,
		wasTruncated,
	}
}
