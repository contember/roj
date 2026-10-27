import { describe, expect, test } from 'bun:test'
import { estimateDocumentTokens, estimateMessagesTokens, estimateTokens } from './tokens.js'

const base64OfSize = (bytes: number): string => Buffer.alloc(bytes, 7).toString('base64')

describe('estimateDocumentTokens', () => {
	test('counts 3,000 tokens per started 10 KB page', () => {
		expect(estimateDocumentTokens(base64OfSize(10 * 1024))).toBe(3_000)
		expect(estimateDocumentTokens(base64OfSize(10 * 1024 + 1))).toBe(6_000)
		expect(estimateDocumentTokens(base64OfSize(100 * 1024))).toBe(30_000)
	})

	test('a tiny document still costs a page', () => {
		expect(estimateDocumentTokens(base64OfSize(1))).toBe(3_000)
	})
})

describe('estimateMessagesTokens', () => {
	test('counts a document by its size, not by the characters of its base64', () => {
		const data = base64OfSize(1_000 * 1024)
		const tokens = estimateMessagesTokens([{
			role: 'user',
			content: [{ type: 'document', document: { mediaType: 'application/pdf', data } }, { type: 'text', text: 'Transcribe it.' }],
		}])

		const withoutDocument = estimateMessagesTokens([{
			role: 'user',
			content: [{ type: 'document' }, { type: 'text', text: 'Transcribe it.' }],
		}])
		expect(tokens).toBe(withoutDocument + 300_000)
	})

	test('finds a document nested in a tool result', () => {
		const data = base64OfSize(1024)
		const tokens = estimateMessagesTokens([{
			role: 'tool',
			content: { content: [{ type: 'document', document: { mediaType: 'application/pdf', data } }], toolCallId: 'tc_1' },
		}])

		expect(tokens).toBeGreaterThanOrEqual(3_000)
		expect(tokens).toBeLessThan(3_100)
	})

	test('estimates text and image items from their JSON as before', () => {
		const content = [{ type: 'text', text: 'Look at this.' }, { type: 'image_url', imageUrl: { url: 'file:///shot.png' } }]

		expect(estimateMessagesTokens([{ role: 'user', content }])).toBe(estimateTokens(JSON.stringify(content)) + 4)
		expect(estimateMessagesTokens([{ role: 'user', content: 'Hello' }])).toBe(estimateTokens('Hello') + 4)
	})
})
