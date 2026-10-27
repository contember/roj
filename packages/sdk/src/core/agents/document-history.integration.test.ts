import { describe, expect, it } from 'bun:test'
import type { LLMMessage } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { llmEvents } from '~/core/llm/state.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

const DOCUMENT_DATA = Buffer.from('%PDF-1.4\nscanned pages\n').toString('base64')
const DOCUMENT_SHA256 = new Bun.CryptoHasher('sha256').update(DOCUMENT_DATA).digest('hex')
const PLACEHOLDER = `[document application/pdf "scan.pdf", ${DOCUMENT_DATA.length} base64 chars, base64 sha256 ${DOCUMENT_SHA256}; content omitted]`

/** Delivers one user message carrying a PDF, the way a host hands the agent a document. */
const createDocumentPlugin = () => {
	let delivered = false
	return definePlugin('document-source')
		.dequeue<true>({
			hasPendingMessages: () => !delivered,
			getPendingMessages: () => delivered
				? null
				: {
					messages: [{
						role: 'user',
						content: [
							{ type: 'document', document: { mediaType: 'application/pdf', data: DOCUMENT_DATA, filename: 'scan.pdf' } },
							{ type: 'text', text: 'Transcribe it.' },
						],
					}],
					token: true,
				},
			markConsumed: async () => {
				delivered = true
			},
		})
		.build()
}

describe('a document in a pending message', () => {
	it('reaches the provider whole, while inference_started and later turns keep its placeholder', async () => {
		const requests: LLMMessage[][] = []
		const harness = new TestHarness({
			presets: [createTestPreset()],
			systemPlugins: [createDocumentPlugin()],
			mockHandler: (request) => {
				requests.push(request.messages)
				return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Here is a file.')
		await session.sendAndWaitForIdle('Anything else?')

		const documentItem = { type: 'document', document: { mediaType: 'application/pdf', data: DOCUMENT_DATA, filename: 'scan.pdf' } }
		const placeholderItem = { type: 'text', text: PLACEHOLDER }

		// The first inference sends the document itself.
		expect(requests[0]).toContainEqual(expect.objectContaining({ role: 'user', content: [documentItem, { type: 'text', text: 'Transcribe it.' }] }))

		// The persisted event holds only the placeholder.
		const started = await session.getEventsByType(llmEvents, 'inference_started')
		expect(started[0]?.messages).toContainEqual(expect.objectContaining({ role: 'user', content: [placeholderItem, { type: 'text', text: 'Transcribe it.' }] }))
		expect(JSON.stringify(await session.getEvents())).not.toContain(DOCUMENT_DATA)

		// History is built from the event, so the next turn sees the placeholder, not the document.
		const laterRequest = requests[requests.length - 1]
		expect(requests.length).toBeGreaterThan(1)
		expect(laterRequest).toContainEqual(expect.objectContaining({ role: 'user', content: [placeholderItem, { type: 'text', text: 'Transcribe it.' }] }))
		expect(JSON.stringify(laterRequest)).not.toContain(DOCUMENT_DATA)

		await harness.shutdown()
	})
})
