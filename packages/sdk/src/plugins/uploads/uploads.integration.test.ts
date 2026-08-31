import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { agentEvents } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import type { TestSession } from '~/testing/index.js'
import type { UploadsState } from './state.js'
import { uploadEvents } from './state.js'

// ============================================================================
// Helpers
// ============================================================================

/** Extract object value from ok Result — asserts result.ok at runtime and validates with schema. */
function okValue<T>(result: { ok: boolean; value?: unknown }, schema: z.ZodType<T>): T {
	expect(result.ok).toBe(true)
	if (!result.ok) throw new Error('Expected ok result')
	return schema.parse(result.value)
}

async function pauseEntryAgent(session: TestSession): Promise<void> {
	const entryAgentId = session.getEntryAgentId()
	if (!entryAgentId) throw new Error('Expected entry agent')
	await session.pauseAgent(entryAgentId, 'Keep upload pending for storage test')
}

/**
 * Consumption commits *after* `inference_completed` on purpose, so a crash in
 * the gap re-delivers the message instead of losing it. The agent therefore
 * reads idle a moment before the consumption events land, and asserting them
 * straight after `waitForIdle()` is a race that only loses under load.
 */
async function waitForEvents<T>(read: () => Promise<T[]>, expected: number, timeoutMs = 2_000): Promise<T[]> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const events = await read()
		if (events.length >= expected || Date.now() >= deadline) return events
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

const uploadResultSchema = z.object({
	uploadId: z.string(),
	status: z.enum(['ready', 'failed']),
	extractedContent: z.string().optional(),
})

const listPendingSchema = z.object({
	uploads: z.array(
		z.object({
			uploadId: z.string(),
			filename: z.string(),
			mimeType: z.string(),
			size: z.number(),
			status: z.string(),
			createdAt: z.number(),
		}).passthrough(),
	),
})

const loadAttachmentsSchema = z.object({
	attachments: z.array(
		z.object({
			uploadId: z.string(),
			filename: z.string(),
			mimeType: z.string(),
			size: z.number(),
			path: z.string(),
			extractedContent: z.string().optional(),
			derivedPaths: z.array(z.string()).optional(),
		}).passthrough(),
	),
})

// ============================================================================
// Tests
// ============================================================================

describe('uploads plugin', () => {
	// =========================================================================
	// upload method
	// =========================================================================

	describe('upload method', () => {
		it('upload valid file → attachment_uploaded event → upload in state', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const fileContent = Buffer.from('Hello, world!')

			const result = await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: 'test.txt',
				mimeType: 'text/plain',
				size: fileContent.length,
				fileBuffer: fileContent,
			})

			const data = okValue(result, uploadResultSchema)
			expect(data).toMatchObject({ uploadId: expect.any(String), status: 'ready' })
			expect(data.extractedContent).toBeUndefined()

			const events = await session.getEventsByType(uploadEvents, 'attachment_uploaded')
			expect(events).toHaveLength(1)
			expect(events[0].filename).toBe('test.txt')
			expect(events[0].mimeType).toBe('text/plain')
			expect(events[0].status).toBe('ready')

			const uploads = selectPluginState<UploadsState>(session.state, 'uploads')
			expect(uploads).toBeDefined()
			if (!uploads) throw new Error('Expected uploads state')
			expect(uploads.pending).toHaveLength(1)
			expect(uploads.pending[0].filename).toBe('test.txt')

			await harness.shutdown()
		})

		// macOS sends the decomposed spelling; a model repeating that name back writes the composed
		// one, and the two are different byte strings. Whatever the agent is told the file is called
		// has to be what `open`/`cp` will find, so both the event and the state carry the stored form.
		it('a decomposed filename is stored and reported composed', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const fileContent = Buffer.from('Ahoj')
			const decomposed = 'Veronika Paulova\u0301.txt'.normalize('NFD')
			const composed = decomposed.normalize('NFC')
			expect(decomposed).not.toBe(composed)

			const result = await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: decomposed,
				mimeType: 'text/plain',
				size: fileContent.length,
				fileBuffer: fileContent,
			})

			okValue(result, uploadResultSchema)

			const events = await session.getEventsByType(uploadEvents, 'attachment_uploaded')
			expect(events[0].filename).toBe(composed)

			const uploads = selectPluginState<UploadsState>(session.state, 'uploads')
			if (!uploads) throw new Error('Expected uploads state')
			expect(uploads.pending[0].filename).toBe(composed)

			await harness.shutdown()
		})

		it('upload file exceeding 10MB → error', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			const result = await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: 'huge.txt',
				mimeType: 'text/plain',
				size: 11 * 1024 * 1024, // 11MB
				fileBuffer: Buffer.from('tiny'),
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.message).toContain('File too large')
			}

			await harness.shutdown()
		})

		it('upload unsupported MIME type → error', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			const result = await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: 'malware.exe',
				mimeType: 'application/x-msdownload',
				size: 11,
				fileBuffer: Buffer.from('binary data'),
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.message).toContain('Unsupported file type')
			}

			await harness.shutdown()
		})

		it('upload without preprocessor → extractedContent undefined', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const fileContent = Buffer.from('plain text content')

			const result = await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: 'doc.txt',
				mimeType: 'text/plain',
				size: fileContent.length,
				fileBuffer: fileContent,
			})

			const data = okValue(result, uploadResultSchema)
			expect(data.extractedContent).toBeUndefined()
			expect(data.status).toBe('ready')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// dequeue
	// =========================================================================

	describe('dequeue', () => {
		it('upload arriving while agent is idle wakes exactly one inference', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Got it', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const fileContent = Buffer.from('Important document')

			await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: 'doc.txt',
				mimeType: 'text/plain',
				size: fileContent.length,
				fileBuffer: fileContent,
			})

			await session.waitForIdle()
			expect(harness.llmProvider.getCallCount()).toBe(1)

			// Check that the LLM received the attachment in its messages
			const lastRequest = harness.llmProvider.getLastRequest()
			expect(lastRequest).toBeDefined()
			if (!lastRequest) throw new Error('Expected lastRequest')

			const attachmentMessage = lastRequest.messages.find(
				(m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<attachment'),
			)
			expect(attachmentMessage).toBeDefined()
			if (!attachmentMessage || typeof attachmentMessage.content !== 'string') {
				throw new Error('Expected attachment message with string content')
			}
			expect(attachmentMessage.content).toContain('filename="doc.txt"')
			expect(attachmentMessage.content).toContain('type="text/plain"')

			const consumedEvents = await waitForEvents(() => session.getEventsByType(agentEvents, 'agent_input_consumed'), 1)
			expect(consumedEvents).toHaveLength(1)
			expect(consumedEvents[0].sourcePlugins).toContain('uploads')

			await harness.shutdown()
		})

		it('several quick uploads debounce into one inference and one consumption event', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Got it', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const filenames = ['one.txt', 'two.txt', 'three.txt']
			await Promise.all(filenames.map((filename) => {
				const fileContent = Buffer.from(`Content of ${filename}`)
				return session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename,
					mimeType: 'text/plain',
					size: fileContent.length,
					fileBuffer: fileContent,
				})
			}))

			await session.waitForIdle()
			expect(harness.llmProvider.getCallCount()).toBe(1)

			const lastRequest = harness.llmProvider.getLastRequest()
			expect(lastRequest).toBeDefined()
			const requestText = lastRequest?.messages
				.map((message) => typeof message.content === 'string' ? message.content : '')
				.join('\n') ?? ''
			for (const filename of filenames) {
				expect(requestText).toContain(`filename="${filename}"`)
			}

			const consumedEvents = await waitForEvents(() => session.getEventsByType(uploadEvents, 'attachments_consumed'), 1)
			expect(consumedEvents).toHaveLength(1)
			expect(consumedEvents[0].uploadIds).toHaveLength(3)

			const uploadsAfter = selectPluginState<UploadsState>(session.state, 'uploads')
			expect(uploadsAfter).toBeDefined()
			if (!uploadsAfter) throw new Error('Expected uploads state')
			expect(uploadsAfter.pending).toHaveLength(0)

			await harness.shutdown()
		})

		it('upload does not wake a paused agent', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Got it', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Paused by user')

			const fileContent = Buffer.from('Wait until resume')
			await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: 'paused.txt',
				mimeType: 'text/plain',
				size: fileContent.length,
				fileBuffer: fileContent,
			})

			await new Promise((resolve) => setTimeout(resolve, 25))
			expect(harness.llmProvider.getCallCount()).toBe(0)
			expect(session.state.agents.get(entryAgentId)?.status).toBe('paused')

			const uploads = selectPluginState<UploadsState>(session.state, 'uploads')
			expect(uploads?.pending).toHaveLength(1)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// listPending
	// =========================================================================

	describe('listPending', () => {
		it('list pending uploads → returns pending files', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await pauseEntryAgent(session)

			await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: 'file1.txt',
				mimeType: 'text/plain',
				size: 5,
				fileBuffer: Buffer.from('hello'),
			})
			await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: 'file2.txt',
				mimeType: 'text/markdown',
				size: 5,
				fileBuffer: Buffer.from('world'),
			})

			const data = okValue(
				await session.callPluginMethod('uploads.listPending', {
					sessionId: String(session.sessionId),
				}),
				listPendingSchema,
			)

			expect(data.uploads).toHaveLength(2)
			expect(data.uploads).toEqual(expect.arrayContaining([
				expect.objectContaining({ filename: 'file1.txt' }),
				expect.objectContaining({ filename: 'file2.txt' }),
			]))

			await harness.shutdown()
		})

		it('used uploads not listed', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await pauseEntryAgent(session)

			const uploadData = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'used.txt',
					mimeType: 'text/plain',
					size: 4,
					fileBuffer: Buffer.from('data'),
				}),
				uploadResultSchema,
			)

			await session.callPluginMethod('uploads.markUsed', {
				sessionId: String(session.sessionId),
				uploadIds: [uploadData.uploadId],
				messageId: 'msg-1',
			})

			const listData = okValue(
				await session.callPluginMethod('uploads.listPending', {
					sessionId: String(session.sessionId),
				}),
				listPendingSchema,
			)
			expect(listData.uploads).toHaveLength(0)

			await harness.shutdown()
		})

		it('deleted uploads not listed', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await pauseEntryAgent(session)

			const uploadData = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'deleteme.txt',
					mimeType: 'text/plain',
					size: 4,
					fileBuffer: Buffer.from('data'),
				}),
				uploadResultSchema,
			)

			await session.callPluginMethod('uploads.delete', {
				sessionId: String(session.sessionId),
				uploadId: uploadData.uploadId,
			})

			const listData = okValue(
				await session.callPluginMethod('uploads.listPending', {
					sessionId: String(session.sessionId),
				}),
				listPendingSchema,
			)
			expect(listData.uploads).toHaveLength(0)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// delete
	// =========================================================================

	describe('delete', () => {
		it('delete unused upload → marked as deleted', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await pauseEntryAgent(session)

			const uploadData = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'todelete.txt',
					mimeType: 'text/plain',
					size: 4,
					fileBuffer: Buffer.from('data'),
				}),
				uploadResultSchema,
			)

			const deleteResult = await session.callPluginMethod('uploads.delete', {
				sessionId: String(session.sessionId),
				uploadId: uploadData.uploadId,
			})
			expect(deleteResult.ok).toBe(true)

			const listData = okValue(
				await session.callPluginMethod('uploads.listPending', {
					sessionId: String(session.sessionId),
				}),
				listPendingSchema,
			)
			expect(listData.uploads).toHaveLength(0)

			await harness.shutdown()
		})

		it('delete used upload → error', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await pauseEntryAgent(session)

			const uploadData = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'used.txt',
					mimeType: 'text/plain',
					size: 4,
					fileBuffer: Buffer.from('data'),
				}),
				uploadResultSchema,
			)

			await session.callPluginMethod('uploads.markUsed', {
				sessionId: String(session.sessionId),
				uploadIds: [uploadData.uploadId],
				messageId: 'msg-1',
			})

			const deleteResult = await session.callPluginMethod('uploads.delete', {
				sessionId: String(session.sessionId),
				uploadId: uploadData.uploadId,
			})

			expect(deleteResult.ok).toBe(false)
			if (!deleteResult.ok) {
				expect(deleteResult.error.message).toContain('Cannot delete')
			}

			await harness.shutdown()
		})

		it('delete non-existent upload → error', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			const deleteResult = await session.callPluginMethod('uploads.delete', {
				sessionId: String(session.sessionId),
				uploadId: 'nonexistent-id',
			})

			expect(deleteResult.ok).toBe(false)
			if (!deleteResult.ok) {
				expect(deleteResult.error.message).toContain('Upload not found')
			}

			await harness.shutdown()
		})
	})

	// =========================================================================
	// markUsed
	// =========================================================================

	describe('markUsed', () => {
		it('mark uploads as used → no longer listed in pending', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await pauseEntryAgent(session)

			const uploadData = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'mark.txt',
					mimeType: 'text/plain',
					size: 4,
					fileBuffer: Buffer.from('data'),
				}),
				uploadResultSchema,
			)

			const markResult = await session.callPluginMethod('uploads.markUsed', {
				sessionId: String(session.sessionId),
				uploadIds: [uploadData.uploadId],
				messageId: 'msg-42',
			})
			expect(markResult.ok).toBe(true)

			const listData = okValue(
				await session.callPluginMethod('uploads.listPending', {
					sessionId: String(session.sessionId),
				}),
				listPendingSchema,
			)
			expect(listData.uploads).toHaveLength(0)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// loadAttachments
	// =========================================================================

	describe('loadAttachments', () => {
		it('load valid upload → returns attachment data', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			const uploadData = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'load.txt',
					mimeType: 'text/plain',
					size: 11,
					fileBuffer: Buffer.from('hello world'),
				}),
				uploadResultSchema,
			)

			const data = okValue(
				await session.callPluginMethod('uploads.loadAttachments', {
					sessionId: String(session.sessionId),
					uploadIds: [uploadData.uploadId],
				}),
				loadAttachmentsSchema,
			)

			expect(data.attachments).toHaveLength(1)
			expect(data.attachments).toEqual([
				expect.objectContaining({
					filename: 'load.txt',
					mimeType: 'text/plain',
					size: 11,
					path: expect.any(String),
				}),
			])

			await harness.shutdown()
		})

		it('load non-existent upload → error', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			const loadResult = await session.callPluginMethod('uploads.loadAttachments', {
				sessionId: String(session.sessionId),
				uploadIds: ['nonexistent-id'],
			})

			expect(loadResult.ok).toBe(false)
			if (!loadResult.ok) {
				expect(loadResult.error.message).toContain('Upload not found')
			}

			await harness.shutdown()
		})

		it('load upload with non-matching sessionId → Upload not found', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			const uploadData = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'owned.txt',
					mimeType: 'text/plain',
					size: 4,
					fileBuffer: Buffer.from('data'),
				}),
				uploadResultSchema,
			)

			// The file is stored under the real sessionId path, so passing a
			// different sessionId means meta.json won't be found at all.
			const loadResult = await session.callPluginMethod('uploads.loadAttachments', {
				sessionId: 'wrong-session-id',
				uploadIds: [uploadData.uploadId],
			})

			expect(loadResult.ok).toBe(false)
			if (!loadResult.ok) {
				expect(loadResult.error.message).toContain('Upload not found')
			}

			await harness.shutdown()
		})

		// =========================================================================
		// uploadAsync method
		// =========================================================================

		it('uploadAsync returns processing, then ready upload wakes the idle agent', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const fileContent = Buffer.from('Hello, async world!')

			const result = await session.callPluginMethod('uploads.uploadAsync', {
				sessionId: String(session.sessionId),
				filename: 'async.txt',
				mimeType: 'text/plain',
				size: fileContent.length,
				fileBuffer: fileContent,
			})

			const data = okValue(
				result,
				z.object({ uploadId: z.string(), status: z.enum(['processing']) }),
			)
			expect(data.status).toBe('processing')

			// Wait for the terminal statusChanged notification (ready or failed).
			const terminal = await harness.notifications.waitFor((n) => {
				if (n.pluginName !== 'uploads' || n.type !== 'uploadStatusChanged') return false
				const p = n.payload as { uploadId: string; status: string }
				return p.uploadId === data.uploadId && (p.status === 'ready' || p.status === 'failed')
			})
			expect((terminal.payload as { status: string }).status).toBe('ready')

			// Two attachment_uploaded events were emitted: processing → ready.
			const events = await session.getEventsByType(uploadEvents, 'attachment_uploaded')
			const own = events.filter((e) => String(e.uploadId) === data.uploadId)
			expect(own).toHaveLength(2)
			expect(own[0].status).toBe('processing')
			expect(own[1].status).toBe('ready')

			await session.waitForIdle()
			expect(harness.llmProvider.getCallCount()).toBe(1)

			// The ready upload was delivered and consumed by the woken agent.
			const uploads = selectPluginState<UploadsState>(session.state, 'uploads')
			if (!uploads) throw new Error('Expected uploads state')
			expect(uploads.pending).toHaveLength(0)

			// First notification was processing.
			const all = harness.notifications.getByType('uploads', 'uploadStatusChanged')
			expect(all.length).toBeGreaterThanOrEqual(2)
			expect((all[0]?.payload as { status: string }).status).toBe('processing')

			await harness.shutdown()
		})

		it('uploadAsync rejects oversize file synchronously (no event)', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			const result = await session.callPluginMethod('uploads.uploadAsync', {
				sessionId: String(session.sessionId),
				filename: 'huge.txt',
				mimeType: 'text/plain',
				size: 11 * 1024 * 1024,
				fileBuffer: Buffer.from('tiny'),
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.message).toContain('File too large')
			}

			const events = await session.getEventsByType(uploadEvents, 'attachment_uploaded')
			expect(events).toHaveLength(0)

			await harness.shutdown()
		})

		it('uploadAsync — listPending exposes processing then ready', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await pauseEntryAgent(session)

			const result = await session.callPluginMethod('uploads.uploadAsync', {
				sessionId: String(session.sessionId),
				filename: 'list-async.txt',
				mimeType: 'text/plain',
				size: 4,
				fileBuffer: Buffer.from('data'),
			})

			const data = okValue(
				result,
				z.object({ uploadId: z.string(), status: z.enum(['processing']) }),
			)

			// Wait for terminal notification so the second meta.json write has landed.
			await harness.notifications.waitFor((n) => {
				if (n.pluginName !== 'uploads' || n.type !== 'uploadStatusChanged') return false
				const p = n.payload as { uploadId: string; status: string }
				return p.uploadId === data.uploadId && p.status === 'ready'
			})

			const listResult = await session.callPluginMethod('uploads.listPending', {
				sessionId: String(session.sessionId),
			})
			const list = okValue(listResult, listPendingSchema)
			const ours = list.uploads.find((u) => u.uploadId === data.uploadId)
			expect(ours).toBeDefined()
			expect(ours?.status).toBe('ready')

			await harness.shutdown()
		})

		it('load deleted upload → error (not ready)', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await pauseEntryAgent(session)

			const uploadData = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'notready.txt',
					mimeType: 'text/plain',
					size: 4,
					fileBuffer: Buffer.from('data'),
				}),
				uploadResultSchema,
			)

			// Delete sets status to 'deleted', which is not 'ready'
			await session.callPluginMethod('uploads.delete', {
				sessionId: String(session.sessionId),
				uploadId: uploadData.uploadId,
			})

			const loadResult = await session.callPluginMethod('uploads.loadAttachments', {
				sessionId: String(session.sessionId),
				uploadIds: [uploadData.uploadId],
			})

			expect(loadResult.ok).toBe(false)
			if (!loadResult.ok) {
				expect(loadResult.error.message).toContain('Upload not ready')
			}

			await harness.shutdown()
		})
	})
})
