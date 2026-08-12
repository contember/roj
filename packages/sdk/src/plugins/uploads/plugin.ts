import z from 'zod/v4'
import { ValidationErrors } from '~/core/errors.js'
import type { FileStore } from '~/core/file-store/types.js'
import type { InferenceContext } from '~/core/llm/provider.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { SessionId } from '~/core/sessions/schema.js'
import { getEntryAgentId } from '~/core/sessions/state.js'
import { ArchiveBudget, type ArchiveLimitOverrides } from '~/lib/archive/index.js'
import { Err, Ok, type Result } from '~/lib/utils/result.js'
import type { PreprocessorRegistry, PreprocessorResult } from './preprocessor.js'
import { generateUploadId, type MessageAttachment, UploadId, type UploadMetadata } from './schema.js'
import { type PendingUpload, uploadEvents, type UploadsState } from './state.js'

// ============================================================================
// Notification schemas
// ============================================================================

const statusChangedSchema = z.object({
	sessionId: z.string(),
	uploadId: z.string(),
	status: z.enum(['processing', 'ready', 'failed']),
	extractedContent: z.string().optional(),
	error: z.string().optional(),
})

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
const PROCESSING_ABORT_GRACE_MS = 1_000

// ============================================================================
// Config
// ============================================================================

export interface UploadsPluginConfig {
	dataFileStore: FileStore
	preprocessorRegistry?: PreprocessorRegistry
	processingTimeoutMs?: number
	processingAbortGraceMs?: number
	archiveLimits?: ArchiveLimitOverrides
}

interface UploadInput {
	sessionId: string
	filename: string
	mimeType: string
	size: number
	fileBuffer: Buffer
}

interface UploadResult {
	status: 'ready' | 'failed'
	extractedContent?: string
	derivedPaths?: string[]
	error?: string
}

interface ActiveUpload {
	controller: AbortController
	completion: Promise<void>
}

interface UploadsPluginContext {
	activeUploads: Map<string, ActiveUpload>
	deletedUploads: Set<string>
	operationQueues: Map<string, Promise<void>>
	closing: boolean
}

interface PreparedUpload {
	uploadId: ReturnType<typeof generateUploadId>
	uploadIdStr: string
	uploadStore: FileStore
	filePath: string
	createdAt: number
	lifecycle: UploadLifecycle
}

interface UploadLifecycle {
	controller: AbortController
	start<T>(run: (controller: AbortController) => Promise<T>): Promise<T>
	abandon(): void
}

// ============================================================================
// Helpers
// ============================================================================

function isAllowedMimeType(mimeType: string): boolean {
	return ALLOWED_MIME_TYPES.some((allowed) => (allowed.endsWith('/') ? mimeType.startsWith(allowed) : mimeType === allowed))
}

function formatUploadsForLLM(uploads: PendingUpload[], sessionRoot: string): string {
	const blocks = uploads.map((u) => {
		const basePath = `${sessionRoot}/uploads/${u.uploadId}`
		const content = u.extractedContent ?? `[File uploaded: ${u.filename}]`
		return `<attachment uploadId="${u.uploadId}" filename="${u.filename}" type="${u.mimeType}" basePath="${basePath}">\n${content}\n</attachment>`
	})
	return blocks.join('\n')
}

function validateUploadInput(input: Pick<UploadInput, 'size' | 'mimeType'>): string | undefined {
	if (input.size > MAX_FILE_SIZE) return `File too large: max ${MAX_FILE_SIZE / (1024 * 1024)}MB`
	if (!isAllowedMimeType(input.mimeType)) return `Unsupported file type: ${input.mimeType}`
	return undefined
}

function reserveUploadLifecycle(pluginContext: UploadsPluginContext, uploadId: string): UploadLifecycle {
	const controller = new AbortController()
	if (pluginContext.closing) controller.abort(new Error('Session is closing'))
	let resolveCompletion = () => {}
	const completion = new Promise<void>((resolve) => {
		resolveCompletion = resolve
	})
	const operation: ActiveUpload = { controller, completion }
	pluginContext.activeUploads.set(uploadId, operation)
	let settled = false
	const settle = () => {
		if (settled) return
		settled = true
		resolveCompletion()
		if (pluginContext.activeUploads.get(uploadId) === operation) pluginContext.activeUploads.delete(uploadId)
	}
	return {
		controller,
		start<T>(run: (signalController: AbortController) => Promise<T>): Promise<T> {
			const result = run(controller)
			result.then(settle, settle)
			return result
		},
		abandon: settle,
	}
}

async function prepareUpload(args: { pluginContext: UploadsPluginContext; dataFileStore: FileStore; input: UploadInput }): Promise<Result<PreparedUpload, string>> {
	const validationError = validateUploadInput(args.input)
	if (validationError) return Err(validationError)

	const uploadId = generateUploadId()
	const uploadIdStr = String(uploadId)
	const lifecycle = reserveUploadLifecycle(args.pluginContext, uploadIdStr)
	if (lifecycle.controller.signal.aborted) {
		lifecycle.abandon()
		return Err('Session is closing')
	}
	const uploadStore = args.dataFileStore.scoped(`sessions/${args.input.sessionId}/uploads/${uploadId}`)
	const writeResult = await uploadStore.write(args.input.filename, args.input.fileBuffer)
	if (!writeResult.ok) {
		lifecycle.abandon()
		return Err('Failed to write file')
	}
	if (args.pluginContext.closing) {
		await uploadStore.remove(args.input.filename)
		lifecycle.abandon()
		return Err('Session is closing')
	}
	return Ok({
		uploadId,
		uploadIdStr,
		uploadStore,
		filePath: writeResult.value.path,
		createdAt: Date.now(),
		lifecycle,
	})
}

type PreprocessorOutcome = { kind: 'completed'; result: Result<PreprocessorResult, Error> } | { kind: 'threw'; error: unknown }

async function runPreprocessor(args: {
	uploadStore: FileStore
	filePath: string
	mimeType: string
	preprocessorRegistry?: PreprocessorRegistry
	processingTimeoutMs?: number
	processingAbortGraceMs?: number
	archiveLimits?: ArchiveLimitOverrides
	controller: AbortController
	inferenceContext?: Omit<InferenceContext, 'signal'>
}): Promise<UploadResult> {
	const preprocessor = args.preprocessorRegistry?.getForMimeType(args.mimeType)
	if (!preprocessor) return { status: 'ready' }

	let timedOut = false
	const processPromise: Promise<PreprocessorOutcome> = (async () => {
		try {
			return {
				kind: 'completed',
				result: await preprocessor.process(args.filePath, args.mimeType, {
					files: args.uploadStore,
					signal: args.controller.signal,
					inferenceContext: args.inferenceContext,
					archiveBudget: new ArchiveBudget(args.archiveLimits),
				}),
			}
		} catch (error) {
			return { kind: 'threw', error }
		}
	})()
	let resolveAbort: (() => void) | undefined
	const aborted = new Promise<{ kind: 'aborted' }>((resolve) => {
		if (args.controller.signal.aborted) {
			resolve({ kind: 'aborted' })
			return
		}
		resolveAbort = () => resolve({ kind: 'aborted' })
		args.controller.signal.addEventListener('abort', resolveAbort, {
			once: true,
		})
	})
	const timeoutId = setTimeout(() => {
		timedOut = true
		args.controller.abort(new Error('Processing timeout'))
	}, args.processingTimeoutMs ?? PROCESSING_TIMEOUT_MS)

	let outcome: PreprocessorOutcome | undefined
	let graceTimeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		const first = await Promise.race([processPromise, aborted])
		if (first.kind === 'aborted') {
			const grace = new Promise<{ kind: 'grace-expired' }>((resolve) => {
				graceTimeoutId = setTimeout(() => resolve({ kind: 'grace-expired' }), args.processingAbortGraceMs ?? PROCESSING_ABORT_GRACE_MS)
			})
			const afterAbort = await Promise.race([processPromise, grace])
			if (afterAbort.kind !== 'grace-expired') outcome = afterAbort
		} else {
			outcome = first
		}
	} finally {
		clearTimeout(timeoutId)
		if (graceTimeoutId) clearTimeout(graceTimeoutId)
		if (resolveAbort) args.controller.signal.removeEventListener('abort', resolveAbort)
	}

	if (args.controller.signal.aborted) {
		return {
			status: 'failed',
			error: timedOut ? 'Processing timeout' : 'Processing cancelled',
		}
	}
	if (outcome?.kind === 'threw') {
		return {
			status: 'failed',
			error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
		}
	}
	if (!outcome) return { status: 'failed', error: 'Processing failed' }
	if (!outcome.result.ok) return { status: 'failed', error: outcome.result.error.message }
	return {
		status: 'ready',
		extractedContent: outcome.result.value.extractedContent,
		derivedPaths: outcome.result.value.derivedPaths,
	}
}

async function writeMetadata(uploadStore: FileStore, metadata: UploadMetadata): Promise<void> {
	const result = await uploadStore.write('meta.json', JSON.stringify(metadata, null, 2))
	if (!result.ok) throw new Error(result.error)
}

function createFinalMetadata(args: { prepared: PreparedUpload; sessionId: SessionId; input: UploadInput; result: UploadResult }): UploadMetadata {
	return {
		uploadId: args.prepared.uploadId,
		sessionId: args.sessionId,
		filename: args.input.filename,
		mimeType: args.input.mimeType,
		size: args.input.size,
		path: args.prepared.filePath,
		status: args.result.status,
		extractedContent: args.result.extractedContent,
		derivedPaths: args.result.derivedPaths,
		error: args.result.error,
		createdAt: args.prepared.createdAt,
		completedAt: Date.now(),
	}
}

function createUploadResultEvent(input: UploadInput, prepared: PreparedUpload, result: UploadResult) {
	return uploadEvents.create('attachment_uploaded', {
		uploadId: prepared.uploadId,
		filename: input.filename,
		mimeType: input.mimeType,
		size: input.size,
		status: result.status,
		extractedContent: result.extractedContent,
		derivedPaths: result.derivedPaths,
		error: result.error,
	})
}

async function withUploadLock<T>(pluginContext: UploadsPluginContext, uploadId: string, run: () => Promise<T>): Promise<T> {
	const previous = pluginContext.operationQueues.get(uploadId) ?? Promise.resolve()
	let release = () => {}
	const current = new Promise<void>((resolve) => {
		release = resolve
	})
	pluginContext.operationQueues.set(uploadId, current)
	await previous
	try {
		return await run()
	} finally {
		release()
		if (pluginContext.operationQueues.get(uploadId) === current) pluginContext.operationQueues.delete(uploadId)
	}
}

async function processUpload(args: {
	pluginContext: UploadsPluginContext
	prepared: PreparedUpload
	sessionId: SessionId
	input: UploadInput
	config: UploadsPluginConfig
	inferenceContext?: Omit<InferenceContext, 'signal'>
	onFinal: (result: UploadResult) => Promise<void>
}): Promise<UploadResult> {
	const result = await runPreprocessor({
		uploadStore: args.prepared.uploadStore,
		filePath: args.prepared.filePath,
		mimeType: args.input.mimeType,
		preprocessorRegistry: args.config.preprocessorRegistry,
		processingTimeoutMs: args.config.processingTimeoutMs,
		processingAbortGraceMs: args.config.processingAbortGraceMs,
		archiveLimits: args.config.archiveLimits,
		controller: args.prepared.lifecycle.controller,
		inferenceContext: args.inferenceContext,
	})
	await withUploadLock(args.pluginContext, args.prepared.uploadIdStr, async () => {
		if (args.pluginContext.deletedUploads.has(args.prepared.uploadIdStr)) return
		await writeMetadata(
			args.prepared.uploadStore,
			createFinalMetadata({
				prepared: args.prepared,
				sessionId: args.sessionId,
				input: args.input,
				result,
			}),
		)
		if (!args.pluginContext.closing) await args.onFinal(result)
	})
	return result
}

async function removeUploadFiles(uploadStore: FileStore, path = ''): Promise<Result<void, string>> {
	const listResult = await uploadStore.list(path, { maxDepth: 1 })
	if (!listResult.ok) return listResult
	for (const entry of listResult.value) {
		const entryPath = path ? `${path}/${entry.name}` : entry.name
		if (entry.type === 'directory') {
			const nested = await removeUploadFiles(uploadStore, entryPath)
			if (!nested.ok) return nested
			continue
		}
		if (entryPath === 'meta.json') continue
		if (entry.type !== 'file' && entry.type !== 'symlink') return Err(`Unsupported upload entry: ${entryPath}`)
		const removed = await uploadStore.remove(entryPath)
		if (!removed.ok) return removed
	}
	return Ok(undefined)
}

// ============================================================================
// Plugin
// ============================================================================

export const uploadsPlugin = definePlugin('uploads')
	.pluginConfig<UploadsPluginConfig>()
	.events([uploadEvents])
	.notification('uploadStatusChanged', { schema: statusChangedSchema })
	.state<UploadsState>({
		key: 'uploads',
		initial: (): UploadsState => ({ pending: [] }),
		reduce: (state, event) => {
			switch (event.type) {
				case 'attachment_uploaded': {
					const pending = state.pending.filter((upload) => String(upload.uploadId) !== String(event.uploadId))
					if (event.status !== 'ready') return { ...state, pending }
					const upload: PendingUpload = {
						uploadId: event.uploadId,
						filename: event.filename,
						mimeType: event.mimeType,
						size: event.size,
						status: event.status,
						extractedContent: event.extractedContent,
						derivedPaths: event.derivedPaths,
					}
					return { ...state, pending: [...pending, upload] }
				}
				case 'attachments_consumed': {
					const consumedIds = new Set(event.uploadIds.map(String))
					return {
						...state,
						pending: state.pending.filter((u) => !consumedIds.has(String(u.uploadId))),
					}
				}
				case 'attachment_deletion_completed': {
					return {
						...state,
						pending: state.pending.filter((upload) => String(upload.uploadId) !== String(event.uploadId)),
					}
				}
				default:
					return state
			}
		},
	})
	.context(
		async (): Promise<UploadsPluginContext> => ({
			activeUploads: new Map(),
			deletedUploads: new Set(),
			operationQueues: new Map(),
			closing: false,
		}),
	)
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
				messages: [
					{
						role: 'user',
						content: formatUploadsForLLM(uploads.pending, sessionRoot),
					},
				],
				token: uploads.pending.map((u) => u.uploadId),
			}
		},
		markConsumed: async (ctx, token) => {
			await ctx.emitEvent(
				uploadEvents.create('attachments_consumed', {
					agentId: ctx.agentId,
					uploadIds: token.map(UploadId),
				}),
			)

			// Also mark as used on disk
			const { dataFileStore } = ctx.pluginConfig
			for (const uploadIdStr of token) {
				await withUploadLock(ctx.pluginContext, uploadIdStr, async () => {
					const uploadStore = dataFileStore.scoped(`sessions/${ctx.sessionId}/uploads/${uploadIdStr}`)
					const metaResult = await uploadStore.read('meta.json')
					if (!metaResult.ok) return
					const meta: UploadMetadata = JSON.parse(metaResult.value)
					if (meta.status === 'deleted') return
					meta.usedInMessageId = 'auto-dequeued'
					await writeMetadata(uploadStore, meta)
				})
			}
		},
	})
	.method('listPending', {
		input: z.object({
			sessionId: z.string(),
		}),
		output: z.object({
			uploads: z.array(
				z.object({
					uploadId: z.string(),
					filename: z.string(),
					mimeType: z.string(),
					size: z.number(),
					status: z.enum(['processing', 'ready', 'failed']),
					createdAt: z.number(),
				}),
			),
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
			const reservation = await withUploadLock(ctx.pluginContext, input.uploadId, async () => {
				const metaResult = await uploadStore.read('meta.json')
				if (!metaResult.ok) return Err(ValidationErrors.invalid(`Upload not found: ${input.uploadId}`))
				const meta: UploadMetadata = JSON.parse(metaResult.value)
				if (meta.sessionId !== input.sessionId) {
					return Err(ValidationErrors.invalid('Upload does not belong to this session'))
				}
				if (meta.usedInMessageId) {
					return Err(ValidationErrors.invalid('Cannot delete an upload that has been sent in a message'))
				}
				ctx.pluginContext.deletedUploads.add(input.uploadId)
				const active = ctx.pluginContext.activeUploads.get(input.uploadId)
				active?.controller.abort(new Error('Upload deleted'))
				return Ok(active?.completion)
			})
			if (!reservation.ok) return reservation
			await reservation.value

			return withUploadLock(ctx.pluginContext, input.uploadId, async () => {
				const metaResult = await uploadStore.read('meta.json')
				if (!metaResult.ok) return Err(ValidationErrors.invalid(`Upload not found: ${input.uploadId}`))
				const meta: UploadMetadata = JSON.parse(metaResult.value)
				meta.status = 'deleted'
				await writeMetadata(uploadStore, meta)
				const cleanup = await removeUploadFiles(uploadStore)
				if (!cleanup.ok) return Err(ValidationErrors.invalid(`Could not remove upload: ${input.uploadId}`))
				await ctx.emitEvent(
					uploadEvents.create('attachment_deletion_completed', {
						uploadId: UploadId(input.uploadId),
					}),
				)
				return Ok({})
			})
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
				const result = await withUploadLock(ctx.pluginContext, uploadIdStr, async () => {
					const uploadStore = dataFileStore.scoped(`sessions/${input.sessionId}/uploads/${uploadIdStr}`)
					const metaResult = await uploadStore.read('meta.json')
					if (!metaResult.ok || ctx.pluginContext.deletedUploads.has(uploadIdStr)) {
						return Err(ValidationErrors.invalid(`Upload not found: ${uploadIdStr}`))
					}
					const meta: UploadMetadata = JSON.parse(metaResult.value)
					if (meta.status === 'deleted') return Err(ValidationErrors.invalid(`Upload not found: ${uploadIdStr}`))
					meta.usedInMessageId = input.messageId
					await writeMetadata(uploadStore, meta)
					return Ok({})
				})
				if (!result.ok) return result
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
			const preparedResult = await prepareUpload({
				pluginContext: ctx.pluginContext,
				dataFileStore: ctx.pluginConfig.dataFileStore,
				input,
			})
			if (!preparedResult.ok) return Err(ValidationErrors.invalid(preparedResult.error))
			const prepared = preparedResult.value
			const entryAgentId = getEntryAgentId(ctx.sessionState)
			try {
				const result = await prepared.lifecycle.start(() =>
					processUpload({
						pluginContext: ctx.pluginContext,
						prepared,
						sessionId: ctx.sessionId,
						input,
						config: ctx.pluginConfig,
						inferenceContext: entryAgentId
							? {
									sessionId: String(ctx.sessionId),
									agentId: String(entryAgentId),
									fileStore: ctx.files,
								}
							: undefined,
						onFinal: async (finalResult) => {
							await ctx.emitEvent(createUploadResultEvent(input, prepared, finalResult))
							if (finalResult.status === 'ready' && entryAgentId) ctx.scheduleAgent(entryAgentId)
						},
					}),
				)
				return Ok({
					uploadId: prepared.uploadIdStr,
					status: result.status,
					extractedContent: result.extractedContent,
				})
			} catch (error) {
				return Err(ValidationErrors.invalid(error instanceof Error ? error.message : 'Upload processing failed'))
			}
		},
	})
	.method('uploadAsync', {
		input: z.object({
			sessionId: z.string(),
			filename: z.string(),
			mimeType: z.string(),
			size: z.number(),
			fileBuffer: z.custom<Buffer>(),
		}),
		output: z.object({
			uploadId: z.string(),
			status: z.enum(['processing']),
		}),
		handler: async (ctx, input) => {
			const preparedResult = await prepareUpload({
				pluginContext: ctx.pluginContext,
				dataFileStore: ctx.pluginConfig.dataFileStore,
				input,
			})
			if (!preparedResult.ok) return Err(ValidationErrors.invalid(preparedResult.error))
			const prepared = preparedResult.value
			const processingMeta: UploadMetadata = {
				uploadId: prepared.uploadId,
				sessionId: ctx.sessionId,
				filename: input.filename,
				mimeType: input.mimeType,
				size: input.size,
				path: prepared.filePath,
				status: 'processing',
				createdAt: prepared.createdAt,
			}
			try {
				await writeMetadata(prepared.uploadStore, processingMeta)
				await ctx.emitEvent(
					uploadEvents.create('attachment_uploaded', {
						uploadId: prepared.uploadId,
						filename: input.filename,
						mimeType: input.mimeType,
						size: input.size,
						status: 'processing',
					}),
				)
			} catch (error) {
				prepared.lifecycle.abandon()
				return Err(ValidationErrors.invalid(error instanceof Error ? error.message : 'Could not start upload'))
			}
			ctx.notify('uploadStatusChanged', {
				sessionId: input.sessionId,
				uploadId: prepared.uploadIdStr,
				status: 'processing',
			})

			const { emitEvent, notify, logger, scheduleAgent } = ctx
			const sessionId = ctx.sessionId
			const entryAgentId = getEntryAgentId(ctx.sessionState)
			void prepared.lifecycle
				.start(() =>
					processUpload({
						pluginContext: ctx.pluginContext,
						prepared,
						sessionId,
						input,
						config: ctx.pluginConfig,
						inferenceContext: entryAgentId
							? {
									sessionId: String(sessionId),
									agentId: String(entryAgentId),
									fileStore: ctx.files,
								}
							: undefined,
						onFinal: async (result) => {
							try {
								await emitEvent(createUploadResultEvent(input, prepared, result))
							} catch (error) {
								logger.error('Could not persist upload result event', error instanceof Error ? error : undefined, {
									uploadId: prepared.uploadIdStr,
								})
							}
							if (result.status === 'ready' && entryAgentId) scheduleAgent(entryAgentId)
							notify('uploadStatusChanged', {
								sessionId: input.sessionId,
								uploadId: prepared.uploadIdStr,
								status: result.status,
								extractedContent: result.extractedContent,
								error: result.error,
							})
						},
					}),
				)
				.catch((error) => {
					logger.error('Async upload processing crashed', error instanceof Error ? error : undefined, {
						uploadId: prepared.uploadIdStr,
						filename: input.filename,
					})
				})

			return Ok({
				uploadId: prepared.uploadIdStr,
				status: 'processing',
			})
		},
	})
	.sessionHook('onSessionReady', async (ctx) => {
		const uploadsPath = `sessions/${ctx.sessionId}/uploads`
		const listResult = await ctx.pluginConfig.dataFileStore.list(uploadsPath)
		if (!listResult.ok) return

		for (const entry of listResult.value) {
			if (entry.type !== 'directory') continue
			const uploadStore = ctx.pluginConfig.dataFileStore.scoped(`${uploadsPath}/${entry.name}`)
			try {
				const metaResult = await uploadStore.read('meta.json')
				if (!metaResult.ok) continue
				const metadata: UploadMetadata = JSON.parse(metaResult.value)
				if (String(metadata.sessionId) !== String(ctx.sessionId)) continue
				if (metadata.status === 'deleted') {
					ctx.pluginContext.deletedUploads.add(String(metadata.uploadId))
					continue
				}
				if (metadata.status !== 'processing') continue

				metadata.status = 'failed'
				metadata.error = 'Processing interrupted by restart'
				metadata.completedAt = Date.now()
				await writeMetadata(uploadStore, metadata)
				await ctx.emitEvent(
					uploadEvents.create('attachment_uploaded', {
						uploadId: metadata.uploadId,
						filename: metadata.filename,
						mimeType: metadata.mimeType,
						size: metadata.size,
						status: 'failed',
						error: metadata.error,
					}),
				)
				ctx.notify('uploadStatusChanged', {
					sessionId: String(ctx.sessionId),
					uploadId: String(metadata.uploadId),
					status: 'failed',
					error: metadata.error,
				})
			} catch (error) {
				ctx.logger.warn('Could not recover interrupted upload', {
					uploadId: entry.name,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
	})
	.sessionHook('onSessionClose', async (ctx) => {
		ctx.pluginContext.closing = true
		const active = [...ctx.pluginContext.activeUploads.values()]
		for (const upload of active) upload.controller.abort(new Error('Session is closing'))
		await Promise.all(active.map((upload) => upload.completion))
		ctx.pluginContext.activeUploads.clear()
	})
	.build()
