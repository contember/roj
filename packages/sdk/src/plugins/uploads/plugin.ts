import z from 'zod/v4'
import { ValidationErrors } from '~/core/errors.js'
import type { FileStore } from '~/core/file-store/types.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { PreprocessorRegistry } from './preprocessor.js'
import { generateUploadId, type MessageAttachment, UploadId, type UploadMetadata } from './schema.js'
import { type PendingUpload, uploadEvents, type UploadsState } from './state.js'

// ============================================================================
// Constants
// ============================================================================

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

/** Allowed MIME type patterns */
const ALLOWED_MIME_TYPES = [
	'image/',
	'text/',
	'application/pdf',
	'application/json',
	'application/xml',
	'application/rtf',
	'application/epub+zip',
	'application/xhtml+xml',
	'application/zip',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'application/vnd.oasis.opendocument.text',
]

const PROCESSING_TIMEOUT_MS = 120_000 // 120 seconds

// ============================================================================
// Config
// ============================================================================

export interface UploadsPluginConfig {
	dataFileStore: FileStore
	preprocessorRegistry?: PreprocessorRegistry
}

// ============================================================================
// Helpers
// ============================================================================

function isAllowedMimeType(mimeType: string): boolean {
	return ALLOWED_MIME_TYPES.some((allowed) =>
		allowed.endsWith('/')
			? mimeType.startsWith(allowed)
			: mimeType === allowed
	)
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatUploadsForLLM(uploads: PendingUpload[], sessionRoot: string): string {
	const blocks = uploads.map((u) => {
		const basePath = `${sessionRoot}/uploads/${u.uploadId}`
		const content = u.extractedContent ?? `[File uploaded: ${u.filename}]`
		return `<attachment uploadId="${u.uploadId}" filename="${u.filename}" type="${u.mimeType}" basePath="${basePath}">\n${content}\n</attachment>`
	})
	return blocks.join('\n')
}

// ============================================================================
// Plugin
// ============================================================================

export const uploadsPlugin = definePlugin('uploads')
	.pluginConfig<UploadsPluginConfig>()
	.events([uploadEvents])
	.state<UploadsState>({
		key: 'uploads',
		initial: (): UploadsState => ({ pending: [] }),
		reduce: (state, event) => {
			switch (event.type) {
				case 'attachment_uploaded': {
					if (event.status !== 'ready') return state
					const upload: PendingUpload = {
						uploadId: event.uploadId,
						filename: event.filename,
						mimeType: event.mimeType,
						size: event.size,
						status: event.status,
						extractedContent: event.extractedContent,
						derivedPaths: event.derivedPaths,
					}
					return { ...state, pending: [...state.pending, upload] }
				}
				case 'attachments_consumed': {
					const consumedIds = new Set(event.uploadIds.map(String))
					return {
						...state,
						pending: state.pending.filter((u) => !consumedIds.has(String(u.uploadId))),
					}
				}
				default:
					return state
			}
		},
	})
	.dequeue({
		hasPendingMessages: (ctx) => {
			const uploads = ctx.pluginState
			return uploads.pending.length > 0
		},
		getPendingMessages: (ctx) => {
			const uploads = ctx.pluginState
			if (uploads.pending.length === 0) return null
			const sessionRoot = ctx.files.getRoots().session
			return {
				messages: [{
					role: 'user',
					content: formatUploadsForLLM(uploads.pending, sessionRoot),
				}],
				token: uploads.pending.map((u) => u.uploadId),
			}
		},
		markConsumed: async (ctx, token) => {
			await ctx.emitEvent(uploadEvents.create('attachments_consumed', {
				agentId: ctx.agentId,
				uploadIds: token.map(UploadId),
			}))

			// Also mark as used on disk
			const { dataFileStore } = ctx.pluginConfig
			for (const uploadIdStr of token) {
				const uploadStore = dataFileStore.scoped(`sessions/${ctx.sessionId}/uploads/${uploadIdStr}`)
				const metaResult = await uploadStore.read('meta.json')
				if (metaResult.ok) {
					const meta: UploadMetadata = JSON.parse(metaResult.value)
					meta.usedInMessageId = 'auto-dequeued'
					await uploadStore.write('meta.json', JSON.stringify(meta, null, 2))
				}
			}
		},
	})
	.method('listPending', {
		input: z.object({
			sessionId: z.string(),
		}),
		output: z.object({
			uploads: z.array(z.object({
				uploadId: z.string(),
				filename: z.string(),
				mimeType: z.string(),
				size: z.number(),
				status: z.enum(['processing', 'ready', 'failed']),
				createdAt: z.number(),
			})),
		}),
		handler: async (ctx, input) => {
			const { dataFileStore } = ctx.pluginConfig
			const sessionId = input.sessionId

			const uploadsPath = `sessions/${sessionId}/uploads`
			const listResult = await dataFileStore.list(uploadsPath)

			if (!listResult.ok) {
				return Ok({ uploads: [] })
			}

			const uploads: Array<{
				uploadId: string
				filename: string
				mimeType: string
				size: number
				status: 'processing' | 'ready' | 'failed'
				createdAt: number
			}> = []

			for (const entry of listResult.value) {
				if (entry.type !== 'directory') continue
				const metaResult = await dataFileStore.read(`${uploadsPath}/${entry.name}/meta.json`)
				if (!metaResult.ok) continue

				const meta: UploadMetadata = JSON.parse(metaResult.value)

				// Skip used, deleted, or non-matching session uploads
				if (meta.usedInMessageId) continue
				if (meta.sessionId !== sessionId) continue
				if (meta.status === 'deleted') continue

				const { status } = meta
				if (status === 'processing' || status === 'ready' || status === 'failed') {
					uploads.push({
						uploadId: meta.uploadId,
						filename: meta.filename,
						mimeType: meta.mimeType,
						size: meta.size,
						status,
						createdAt: meta.createdAt,
					})
				}
			}

			return Ok({ uploads })
		},
	})
	.method('delete', {
		input: z.object({
			sessionId: z.string(),
			uploadId: z.string(),
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const { dataFileStore } = ctx.pluginConfig
			const uploadStore = dataFileStore.scoped(`sessions/${input.sessionId}/uploads/${input.uploadId}`)
			const metaResult = await uploadStore.read('meta.json')

			if (!metaResult.ok) {
				return Err(ValidationErrors.invalid(`Upload not found: ${input.uploadId}`))
			}

			const meta: UploadMetadata = JSON.parse(metaResult.value)

			if (meta.sessionId !== input.sessionId) {
				return Err(ValidationErrors.invalid('Upload does not belong to this session'))
			}

			if (meta.usedInMessageId) {
				return Err(ValidationErrors.invalid('Cannot delete an upload that has been sent in a message'))
			}

			// Mark as deleted
			meta.status = 'deleted'
			await uploadStore.write('meta.json', JSON.stringify(meta, null, 2))

			return Ok({})
		},
	})
	.method('loadAttachments', {
		input: z.object({
			sessionId: z.string(),
			uploadIds: z.array(z.string()),
		}),
		output: z.object({
			attachments: z.array(z.unknown()),
		}),
		handler: async (ctx, input) => {
			const { dataFileStore } = ctx.pluginConfig
			const sessionRoot = ctx.files.getRoots().session
			const attachments: MessageAttachment[] = []

			for (const uploadIdStr of input.uploadIds) {
				const metaResult = await dataFileStore.read(`sessions/${input.sessionId}/uploads/${uploadIdStr}/meta.json`)

				if (!metaResult.ok) {
					return Err(ValidationErrors.invalid(`Upload not found: ${uploadIdStr}`))
				}

				const meta: UploadMetadata = JSON.parse(metaResult.value)

				if (meta.sessionId !== input.sessionId) {
					return Err(ValidationErrors.invalid('Upload does not belong to this session'))
				}
				if (meta.status !== 'ready') {
					return Err(ValidationErrors.invalid(`Upload not ready: ${meta.status}`))
				}

				attachments.push({
					uploadId: UploadId(uploadIdStr),
					filename: meta.filename,
					mimeType: meta.mimeType,
					size: meta.size,
					path: `${sessionRoot}/uploads/${uploadIdStr}/${meta.filename}`,
					extractedContent: meta.extractedContent,
					derivedPaths: meta.derivedPaths,
				})
			}

			return Ok({ attachments })
		},
	})
	.method('markUsed', {
		input: z.object({
			sessionId: z.string(),
			uploadIds: z.array(z.string()),
			messageId: z.string(),
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const { dataFileStore } = ctx.pluginConfig

			for (const uploadIdStr of input.uploadIds) {
				const uploadStore = dataFileStore.scoped(`sessions/${input.sessionId}/uploads/${uploadIdStr}`)
				const metaResult = await uploadStore.read('meta.json')
				if (metaResult.ok) {
					const meta: UploadMetadata = JSON.parse(metaResult.value)
					meta.usedInMessageId = input.messageId
					await uploadStore.write('meta.json', JSON.stringify(meta, null, 2))
				}
			}

			return Ok({})
		},
	})
	.method('upload', {
		input: z.object({
			sessionId: z.string(),
			filename: z.string(),
			mimeType: z.string(),
			size: z.number(),
			fileBuffer: z.custom<Buffer>(),
		}),
		output: z.object({
			uploadId: z.string(),
			status: z.enum(['ready', 'failed']),
			extractedContent: z.string().optional(),
		}),
		handler: async (ctx, input) => {
			const { dataFileStore, preprocessorRegistry } = ctx.pluginConfig

			// Validate
			if (input.size > MAX_FILE_SIZE) {
				return Err(ValidationErrors.invalid(`File too large: max ${MAX_FILE_SIZE / (1024 * 1024)}MB`))
			}

			if (!isAllowedMimeType(input.mimeType)) {
				return Err(ValidationErrors.invalid(`Unsupported file type: ${input.mimeType}`))
			}

			// Generate upload ID and scoped store
			const uploadId = generateUploadId()
			const uploadStore = dataFileStore.scoped(`sessions/${input.sessionId}/uploads/${uploadId}`)

			// Write file to disk
			const writeResult = await uploadStore.write(input.filename, input.fileBuffer)

			if (!writeResult.ok) {
				return Err(ValidationErrors.invalid('Failed to write file'))
			}

			const filePath = writeResult.value.path

			// Run preprocessor (with timeout)
			let processingResult: 'success' | 'failed' | 'skipped' = 'skipped'
			let extractedContent: string | undefined
			let derivedPaths: string[] | undefined

			const preprocessor = preprocessorRegistry?.getForMimeType(input.mimeType)

			if (preprocessor) {
				const processPromise = preprocessor.process(filePath, input.mimeType, {
					files: uploadStore,
				})

				const timeoutPromise = sleep(PROCESSING_TIMEOUT_MS).then(() => ({
					ok: false as const,
					error: new Error('Processing timeout'),
				}))

				const result = await Promise.race([processPromise, timeoutPromise])

				if (result.ok) {
					processingResult = 'success'
					extractedContent = result.value.extractedContent
					derivedPaths = result.value.derivedPaths
				} else {
					processingResult = 'failed'
				}
			}

			// Create upload metadata
			const now = Date.now()
			const uploadStatus = processingResult === 'failed' ? 'failed' as const : 'ready' as const
			const metadata: UploadMetadata = {
				uploadId,
				sessionId: ctx.sessionId,
				filename: input.filename,
				mimeType: input.mimeType,
				size: input.size,
				path: filePath,
				status: uploadStatus,
				extractedContent,
				derivedPaths,
				createdAt: now,
				completedAt: now,
			}

			// Save metadata
			await uploadStore.write('meta.json', JSON.stringify(metadata, null, 2))

			// Emit event
			await ctx.emitEvent(uploadEvents.create('attachment_uploaded', {
				uploadId,
				filename: input.filename,
				mimeType: input.mimeType,
				size: input.size,
				status: uploadStatus,
				extractedContent,
				derivedPaths,
			}))

			return Ok({
				uploadId: String(uploadId),
				status: uploadStatus,
				extractedContent,
			})
		},
	})
	.build()
