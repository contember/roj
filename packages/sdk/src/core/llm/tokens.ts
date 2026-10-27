/**
 * Token estimation utilities using tokenx library.
 * Provides ~95-98% accuracy compared to full tokenizers.
 */

import { estimateTokenCount, sliceByTokens } from 'tokenx'
import { base64ByteLength } from './document-content.js'

/** Upper end of what a PDF page costs a native reader: its text plus the page image. */
const DOCUMENT_TOKENS_PER_PAGE = 3_000
/**
 * Page count is not known without parsing the file, so it is derived from an assumed page size.
 * Sized for text PDFs, so the estimate errs high: image-heavy and scanned pages are far larger and over-counted.
 */
const DOCUMENT_BYTES_PER_PAGE = 10 * 1024

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
 * Estimate tokens of a document of `byteLength` bytes: ~3,000 tokens per assumed 10 KB page, at least one page.
 */
export function estimateDocumentTokens(byteLength: number): number {
	return Math.max(1, Math.ceil(byteLength / DOCUMENT_BYTES_PER_PAGE)) * DOCUMENT_TOKENS_PER_PAGE
}

/** File size of a document content item, inline or stored, wherever it sits in a message. */
function documentByteLengthOf(value: unknown): number | undefined {
	if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'document') return undefined
	if (!('document' in value) || typeof value.document !== 'object' || value.document === null) return undefined
	if ('data' in value.document && typeof value.document.data === 'string') return base64ByteLength(value.document.data)
	return 'byteLength' in value.document && typeof value.document.byteLength === 'number' ? value.document.byteLength : undefined
}

/**
 * Estimate total tokens for an array of messages.
 * Includes ~4 tokens overhead per message for role/formatting.
 * A document counts by its size, not by the characters of its base64 payload.
 */
export function estimateMessagesTokens(messages: TokenEstimationMessage[]): number {
	return messages.reduce((sum, msg) => {
		let documentTokens = 0
		const content = typeof msg.content === 'string'
			? msg.content
			: JSON.stringify(msg.content, (_key, value: unknown) => {
				const byteLength = documentByteLengthOf(value)
				if (byteLength === undefined) return value
				documentTokens += estimateDocumentTokens(byteLength)
				return { type: 'document' }
			})
		return sum + estimateTokens(content) + documentTokens + 4 // 4 tokens overhead per message
	}, 0)
}
