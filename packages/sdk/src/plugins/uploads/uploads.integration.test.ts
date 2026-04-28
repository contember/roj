import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
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
		it('pending upload delivered to agent as LLM message with <attachment> XML', async () => {
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

			// Send a message to trigger inference — the pending upload should be dequeued
			await session.sendAndWaitForIdle('Process the file')

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

			await harness.shutdown()
		})

		it('after delivery, upload consumed (attachments_consumed event, removed from pending)', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Got it', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const fileContent = Buffer.from('Some data')

			await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: 'data.txt',
				mimeType: 'text/plain',
				size: fileContent.length,
				fileBuffer: fileContent,
			})

			// Before inference, should be in pending
			const uploadsBefore = selectPluginState<UploadsState>(session.state, 'uploads')
			expect(uploadsBefore).toBeDefined()
			if (!uploadsBefore) throw new Error('Expected uploads state')
			expect(uploadsBefore.pending).toHaveLength(1)

			// Trigger inference
			await session.sendAndWaitForIdle('Handle this')

			// After inference, should be consumed
			const consumedEvents = await session.getEventsByType(uploadEvents, 'attachments_consumed')
			expect(consumedEvents).toHaveLength(1)
			expect(consumedEvents[0].uploadIds).toHaveLength(1)

			// Pending should be empty
			const uploadsAfter = selectPluginState<UploadsState>(session.state, 'uploads')
			expect(uploadsAfter).toBeDefined()
			if (!uploadsAfter) throw new Error('Expected uploads state')
			expect(uploadsAfter.pending).toHaveLength(0)

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

		it('load deleted upload → error (not ready)', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

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
