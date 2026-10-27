import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { agentEvents } from '~/core/agents/state.js'
import type { LLMMessage } from '~/core/agents/state.js'
import type { ChatMessageContentItem } from '~/core/llm/llm-log-types.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { InferenceResponse } from '~/core/llm/provider.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createTool } from '~/core/tools/definition.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { toolEvents } from '~/core/tools/state.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { createTestPreset, TestHarness, TestSession } from '~/testing/index.js'

const DOCUMENT_BYTES = Buffer.from('%PDF-1.4\nscanned pages\n')
const DOCUMENT_DATA = DOCUMENT_BYTES.toString('base64')
const DOCUMENT_SHA256 = new Bun.CryptoHasher('sha256').update(DOCUMENT_BYTES).digest('hex')
const STORED_PATH = `.documents/${DOCUMENT_SHA256}.pdf`
/** What `read_stored` answers when the session store holds the document's bytes. */
const READ_BACK = `read ${DOCUMENT_BYTES.length} bytes, sha256 ${DOCUMENT_SHA256}`

const inlineDocument = { type: 'document' as const, document: { mediaType: 'application/pdf' as const, data: DOCUMENT_DATA, filename: 'scan.pdf' } }
const storedDocumentItem: ChatMessageContentItem = {
	type: 'document',
	document: { mediaType: 'application/pdf', path: STORED_PATH, byteLength: DOCUMENT_BYTES.length, filename: 'scan.pdf' },
}

/** Delivers one user message carrying a PDF, the way a host hands the agent a document. */
const createDocumentPlugin = () => {
	let delivered = false
	return definePlugin('document-source')
		.dequeue<true>({
			hasPendingMessages: () => !delivered,
			getPendingMessages: () => delivered
				? null
				: { messages: [{ role: 'user', content: [inlineDocument, { type: 'text', text: 'Transcribe it.' }] }], token: true },
			markConsumed: async () => {
				delivered = true
			},
		})
		.build()
}

/** Reads a file through the session store, the way a provider reads a stored document back. */
const readStoredPlugin = definePlugin('read-stored')
	.tools(() => [
		createTool({
			name: 'read_stored',
			description: 'Read a stored document back',
			input: z.object({ path: z.string() }),
			execute: async (input, context) => {
				const read = await context.files.session.read(input.path, { type: 'buffer' })
				if (!read.ok) return Err({ message: read.error, recoverable: true })
				return Ok(`read ${read.value.length} bytes, sha256 ${new Bun.CryptoHasher('sha256').update(read.value).digest('hex')}`)
			},
		}),
		createTool({
			name: 'fetch_scan',
			description: 'Return a scanned PDF',
			input: z.object({}),
			execute: async () => Ok([inlineDocument]),
		}),
		createTool({ name: 'noop', description: 'Do nothing', input: z.object({}), execute: async () => Ok('ok') }),
	])
	.build()

/** Swaps every `noop` result for the PDF, as a plugin rewriting a tool's result would. */
const attachScanPlugin = definePlugin('attach-scan')
	.hook('afterToolCall', async (ctx) => ctx.toolCall.name === 'noop' ? { action: 'modify', result: { isError: false, content: [inlineDocument] } } : null)
	.build()

const callTool = (requests: LLMMessage[][], name: string, input: Record<string, unknown> = {}): InferenceResponse => ({
	content: null,
	toolCalls: [{ id: ToolCallId(`tc${requests.length}`), name, input }],
	finishReason: 'tool_calls',
	metrics: MockLLMProvider.defaultMetrics(),
})

const done = (): InferenceResponse => ({ content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() })

/** Answers each user turn by reading the stored document back, then finishes once the tool result is in. */
const readBackEachTurn = (requests: LLMMessage[][]) => (request: { messages: LLMMessage[] }): InferenceResponse => {
	requests.push(request.messages)
	return request.messages[request.messages.length - 1]?.role === 'tool' ? done() : callTool(requests, 'read_stored', { path: STORED_PATH })
}

describe('a document in a pending message', () => {
	it('stays in every inference of the turn and of later turns as a stored reference', async () => {
		const requests: LLMMessage[][] = []
		const harness = new TestHarness({
			presets: [createTestPreset()],
			systemPlugins: [createDocumentPlugin(), readStoredPlugin],
			mockHandler: readBackEachTurn(requests),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Here is a file.')
		await session.sendAndWaitForIdle('Anything else?')

		// Two turns of two inferences each; the second of each turn follows a tool call.
		expect(requests).toHaveLength(4)
		for (const request of requests) {
			expect(request).toContainEqual(expect.objectContaining({ role: 'user', content: [storedDocumentItem, { type: 'text', text: 'Transcribe it.' }] }))
		}

		// The reference names the document's bytes in the session store.
		const completed = await session.getEventsByType(toolEvents, 'tool_completed')
		expect(completed.map((event) => event.result)).toEqual([READ_BACK, READ_BACK])
		expect(JSON.stringify(await session.getEvents())).not.toContain(DOCUMENT_DATA)

		await harness.shutdown()
	})

	it('stays readable in a fork, which gets its own copy of the stored documents', async () => {
		const requests: LLMMessage[][] = []
		const harness = new TestHarness({
			presets: [createTestPreset()],
			systemPlugins: [createDocumentPlugin(), readStoredPlugin],
			mockHandler: readBackEachTurn(requests),
		})

		const source = await harness.createSession('test')
		await source.sendAndWaitForIdle('Here is a file.')
		const sourceEvents = await source.getEvents()
		const forkResult = await harness.sessionManager.forkSession(source.sessionId, sourceEvents.length - 1)
		if (!forkResult.ok) throw new Error('Expected fork')
		const fork = new TestSession(forkResult.value, harness)

		await fork.sendAndWaitForIdle('Read it again.')

		const completed = await fork.getEventsByType(toolEvents, 'tool_completed')
		expect(completed.map((event) => event.result)).toEqual([READ_BACK, READ_BACK])
		expect(requests[requests.length - 1]).toContainEqual(expect.objectContaining({ role: 'user', content: [storedDocumentItem, { type: 'text', text: 'Transcribe it.' }] }))

		await harness.shutdown()
	})
})

describe('a document returned by a tool', () => {
	it('is recorded in tool_completed as a stored reference and reaches the next inference', async () => {
		const requests: LLMMessage[][] = []
		const harness = new TestHarness({
			presets: [createTestPreset()],
			systemPlugins: [readStoredPlugin],
			mockHandler: (request) => {
				requests.push(request.messages)
				return requests.length === 1 ? callTool(requests, 'fetch_scan') : done()
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Fetch the scan.')

		const completed = await session.getEventsByType(toolEvents, 'tool_completed')
		expect(completed.map((event) => event.result)).toEqual([[storedDocumentItem]])
		expect(requests[1]).toContainEqual(expect.objectContaining({ role: 'tool', content: [storedDocumentItem] }))
		expect(JSON.stringify(await session.getEvents())).not.toContain(DOCUMENT_DATA)

		await harness.shutdown()
	})

	it('put there by an afterToolCall hook is recorded in handler_completed and tool_completed only as a reference', async () => {
		const requests: LLMMessage[][] = []
		const harness = new TestHarness({
			presets: [createTestPreset()],
			systemPlugins: [readStoredPlugin, attachScanPlugin],
			mockHandler: (request) => {
				requests.push(request.messages)
				return requests.length === 1 ? callTool(requests, 'noop') : done()
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Run it.')

		const handled = await session.getEventsByType(agentEvents, 'handler_completed')
		expect(handled.filter((event) => event.handlerName === 'afterToolCall').map((event) => event.result)).toEqual([
			{ action: 'modify', result: { isError: false, content: [storedDocumentItem] } },
		])
		const completed = await session.getEventsByType(toolEvents, 'tool_completed')
		expect(completed.map((event) => event.result)).toEqual([[storedDocumentItem]])
		expect(JSON.stringify(await session.getEvents())).not.toContain(DOCUMENT_DATA)

		await harness.shutdown()
	})
})
