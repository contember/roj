import z from 'zod/v4'
import type { AgentId } from '~/core/agents/schema.js'
import { createDomainError, type DomainError, ValidationErrors } from '~/core/errors.js'
import type { FileStore } from '~/core/file-store/types.js'
import type { InferenceContext } from '~/core/llm/provider.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import type { SessionContext } from '~/core/sessions/context.js'
import type { RuntimeLeaseRelease, SessionRuntimeActivity } from '~/core/sessions/runtime-activity.js'
import { SessionId } from '~/core/sessions/schema.js'
import { getEntryAgentId } from '~/core/sessions/state.js'
import { ArchiveBudget, type ArchiveLimitOverrides } from '~/lib/archive/index.js'
import type { Logger } from '~/lib/logger/logger.js'
import { Err, Ok, type Result } from '~/lib/utils/result.js'
import type { PreprocessorRegistry, PreprocessorResult } from './preprocessor.js'
import { generateUploadId, type MessageAttachment, parseUploadId, UploadId, type UploadMetadata, uploadIdSchema } from './schema.js'
import { type PendingUpload, type UploadsState, uploadEvents } from './state.js'

// ============================================================================
// Notification schemas
// ============================================================================

// No producer sets extractedContent: it can be megabytes and clients read it from the state projection.
const statusChangedSchema = z.object({
	sessionId: z.string(),
	uploadId: z.string(),
	status: z.enum(['processing', 'ready', 'failed']),
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
const CLOSE_DRAIN_TIMEOUT_MS = 30_000
const TERMINAL_APPEND_ATTEMPTS = 3
const TERMINAL_APPEND_RETRY_DELAY_MS = 25

/** Store faults are internal: the client gets this fixed text, never the driver's own message. */
const uploadStorageError = (): DomainError => createDomainError('upload_storage_error', 'Failed to write file', 500)

// ============================================================================
// Config
// ============================================================================

export interface UploadsPluginConfig {
	dataFileStore: FileStore
	preprocessorRegistry?: PreprocessorRegistry
	processingTimeoutMs?: number
	processingAbortGraceMs?: number
	/** Bound in ms on the close-time wait for in-flight uploads and mutations. Must be positive; anything else uses the 30s default. */
	closeDrainTimeoutMs?: number
	archiveLimits?: ArchiveLimitOverrides
}

interface UploadInput {
	sessionId: string
	filename: string
	mimeType: string
	size: number
	fileBuffer: Buffer
}

interface UploadDescriptor {
	filename: string
	mimeType: string
	size: number
}

interface UploadResult {
	status: 'ready' | 'failed'
	extractedContent?: string
	derivedPaths?: string[]
	error?: string
}

interface ActiveUpload {
	controller: AbortController
	processingCompletion: Promise<void>
	completion: Promise<void>
	holdTerminalMutation(): RuntimeLeaseRelease
}

interface UploadsPluginContext {
	activeUploads: Map<string, ActiveUpload>
	/** Completion promise -> the lease reason, so an expired close drain can name what is still running. */
	activeMutations: Map<Promise<void>, string>
	deletedUploads: Set<string>
	operationQueues: Map<string, Promise<void>>
	closing: boolean
}

interface PreparedUpload {
	uploadId: ReturnType<typeof generateUploadId>
	uploadIdStr: string
	uploadStore: FileStore
	/** The name as written. Callers report THIS, never their own input — see toStoredFilename. */
	filename: string
	filePath: string
	createdAt: number
	lifecycle: UploadLifecycle
}

interface UploadLifecycle {
	controller: AbortController
	start<T>(run: (controller: AbortController) => Promise<T>): Promise<T>
	attachRuntimeLease(release: RuntimeLeaseRelease): void
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

function withoutKeys<T>(
	values: Record<string, T>,
	uploadIds: readonly string[],
): Record<string, T> {
	if (uploadIds.every((uploadId) => values[uploadId] === undefined)) return values
	const next = { ...values }
	for (const uploadId of uploadIds) delete next[uploadId]
	return next
}

/**
 * True when the value names one entry inside the upload dir and cannot walk anywhere.
 *
 * Deliberately duplicates the download route's boundary check: this is where the bytes
 * are written, and prepareUpload is reachable from callers that never touch HTTP.
 */
function isBasename(value: string): boolean {
	if (value === '' || value === '.' || value === '..') return false
	return !/[/\\\0]/.test(value)
}

/**
 * The single spelling of a filename this plugin stores and reports.
 *
 * Unicode lets the same name be two different byte strings: macOS hands over the decomposed form
 * (`á` as `a` + U+0301), while a model asked to repeat that name writes the composed one. The two
 * do not compare equal, so every `cp`, `read_file` and shell redirect the agent builds from the
 * name it was given misses the file that is actually on disk. Composing on the way in makes the
 * name the agent produces the name that is there.
 */
function toStoredFilename(filename: string): string {
	return filename.normalize('NFC')
}

function validateUploadInput(input: Pick<UploadInput, 'size' | 'mimeType' | 'filename'>): string | undefined {
	if (!isBasename(input.filename)) return 'Invalid filename'
	if (input.size > MAX_FILE_SIZE) return `File too large: max ${MAX_FILE_SIZE / (1024 * 1024)}MB`
	if (!isAllowedMimeType(input.mimeType)) return `Unsupported file type: ${input.mimeType}`
	return undefined
}

function reserveUploadLifecycle(pluginContext: UploadsPluginContext, uploadId: string): UploadLifecycle {
	const controller = new AbortController()
	if (pluginContext.closing) controller.abort(new Error('Session is closing'))
	let resolveProcessingCompletion = () => {}
	const processingCompletion = new Promise<void>((resolve) => {
		resolveProcessingCompletion = resolve
	})
	let resolveCompletion = () => {}
	const completion = new Promise<void>((resolve) => {
		resolveCompletion = resolve
	})
	let processingSettled = false
	let terminalHolds = 0
	let settled = false
	let releaseRuntimeLease: RuntimeLeaseRelease | undefined
	let operation: ActiveUpload
	const settle = () => {
		if (!processingSettled || terminalHolds !== 0 || settled) return
		settled = true
		if (pluginContext.activeUploads.get(uploadId) === operation) pluginContext.activeUploads.delete(uploadId)
		releaseRuntimeLease?.()
		releaseRuntimeLease = undefined
		resolveCompletion()
	}
	const finishProcessing = () => {
		if (processingSettled) return
		processingSettled = true
		resolveProcessingCompletion()
		settle()
	}
	operation = {
		controller,
		processingCompletion,
		completion,
		holdTerminalMutation() {
			if (settled) return () => {}
			terminalHolds++
			let released = false
			return () => {
				if (released) return
				released = true
				terminalHolds--
				settle()
			}
		},
	}
	pluginContext.activeUploads.set(uploadId, operation)
	return {
		controller,
		start<T>(run: (signalController: AbortController) => Promise<T>): Promise<T> {
			let result: Promise<T>
			try {
				result = run(controller)
			} catch (error) {
				finishProcessing()
				return Promise.reject(error)
			}
			result.then(finishProcessing, finishProcessing)
			return result
		},
		attachRuntimeLease(release) {
			if (settled) {
				release()
				return
			}
			if (releaseRuntimeLease) {
				release()
				throw new Error(`Upload ${uploadId} already has a runtime lease`)
			}
			releaseRuntimeLease = release
		},
		abandon: finishProcessing,
	}
}

function runTrackedMutation<T>(args: {
	pluginContext: UploadsPluginContext
	runtimeActivity: SessionRuntimeActivity
	reason: string
	run: () => Promise<T>
}): Promise<T> {
	if (args.pluginContext.closing) return Promise.reject(new Error('Session is closing'))
	const releaseRuntimeLease = args.runtimeActivity.acquire(args.reason)
	let resolveCompletion = () => {}
	const completion = new Promise<void>((resolve) => {
		resolveCompletion = resolve
	})
	args.pluginContext.activeMutations.set(completion, args.reason)
	return (async () => {
		try {
			return await args.run()
		} finally {
			args.pluginContext.activeMutations.delete(completion)
			releaseRuntimeLease()
			resolveCompletion()
		}
	})()
}

async function prepareUpload(args: {
	pluginContext: UploadsPluginContext
	dataFileStore: FileStore
	logger: Logger
	input: UploadInput
}): Promise<Result<PreparedUpload, DomainError>> {
	const filename = toStoredFilename(args.input.filename)
	const validationError = validateUploadInput({ ...args.input, filename })
	if (validationError) return Err(ValidationErrors.invalid(validationError))

	const uploadId = generateUploadId()
	const uploadIdStr = String(uploadId)
	const lifecycle = reserveUploadLifecycle(args.pluginContext, uploadIdStr)
	let prepared: PreparedUpload | undefined
	try {
		if (lifecycle.controller.signal.aborted) return Err(ValidationErrors.invalid('Session is closing'))
		const uploadStore = args.dataFileStore.scoped(`sessions/${args.input.sessionId}/uploads/${uploadId}`)
		const writeResult = await uploadStore.write(filename, args.input.fileBuffer)
		if (!writeResult.ok) {
			args.logger.error('Could not write upload file', undefined, { uploadId: uploadIdStr, filename, error: writeResult.error })
			return Err(uploadStorageError())
		}
		if (args.pluginContext.closing) {
			await uploadStore.remove(filename)
			return Err(ValidationErrors.invalid('Session is closing'))
		}
		prepared = {
			uploadId,
			uploadIdStr,
			uploadStore,
			filename,
			filePath: writeResult.value.path,
			createdAt: Date.now(),
			lifecycle,
		}
		return Ok(prepared)
	} catch (error) {
		// An embedder-supplied store throws its own driver text (bucket, endpoint, request id) — log it, never echo it.
		args.logger.error('Could not write upload file', error instanceof Error ? error : undefined, { uploadId: uploadIdStr, filename })
		return Err(uploadStorageError())
	} finally {
		// The lifecycle is registered before any fs work, so every failure path must settle it —
		// an orphan never resolves its completion and onSessionClose waits on that.
		if (!prepared) lifecycle.abandon()
	}
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

function createFinalMetadata(args: { prepared: PreparedUpload; sessionId: SessionId; upload: UploadDescriptor; result: UploadResult }): UploadMetadata {
	return {
		uploadId: args.prepared.uploadId,
		sessionId: args.sessionId,
		filename: args.upload.filename,
		mimeType: args.upload.mimeType,
		size: args.upload.size,
		path: args.prepared.filePath,
		status: args.result.status,
		extractedContent: args.result.extractedContent,
		derivedPaths: args.result.derivedPaths,
		error: args.result.error,
		createdAt: args.prepared.createdAt,
		completedAt: Date.now(),
	}
}

function createUploadResultEvent(upload: UploadDescriptor, uploadId: ReturnType<typeof generateUploadId>, result: UploadResult) {
	return uploadEvents.create('attachment_uploaded', {
		uploadId,
		filename: upload.filename,
		mimeType: upload.mimeType,
		size: upload.size,
		status: result.status,
		extractedContent: result.extractedContent,
		derivedPaths: result.derivedPaths,
		error: result.error,
	})
}

async function withUploadLock<T>(
	pluginContext: UploadsPluginContext,
	uploadId: string,
	run: () => Promise<T>,
	options?: { allowDuringClose?: boolean },
): Promise<T> {
	if (pluginContext.closing && !options?.allowDuringClose) throw new Error('Session is closing')
	const previous = pluginContext.operationQueues.get(uploadId) ?? Promise.resolve()
	let release = () => {}
	const current = new Promise<void>((resolve) => {
		release = resolve
	})
	pluginContext.operationQueues.set(uploadId, current)
	await previous
	try {
		if (pluginContext.closing && !options?.allowDuringClose) throw new Error('Session is closing')
		return await run()
	} finally {
		release()
		if (pluginContext.operationQueues.get(uploadId) === current) pluginContext.operationQueues.delete(uploadId)
	}
}

/** Resolves true when everything settled, false when the bound expired first. */
async function settleWithTimeout(pending: readonly Promise<unknown>[], timeoutMs: number): Promise<boolean> {
	if (pending.length === 0) return true
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	const expired = new Promise<boolean>((resolve) => {
		timeoutId = setTimeout(() => resolve(false), timeoutMs)
	})
	try {
		return await Promise.race([Promise.allSettled(pending).then(() => true), expired])
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId)
	}
}

/**
 * Appends the terminal event, retrying a transient store failure.
 *
 * Losing the append means the projection never gains the attachment, so it is never
 * auto-dequeued to the agent while the caller was already told the upload is ready.
 * Metadata makes it recoverable, but only when the runtime is next built — with idle
 * eviction off (the default) that is a process restart, so retrying here is the fix.
 */
async function appendTerminalEvent(args: {
	pluginContext: UploadsPluginContext
	append: () => Promise<void>
	logger: Logger
	uploadId: string
	filename: string
}): Promise<boolean> {
	for (let attempt = 1; attempt <= TERMINAL_APPEND_ATTEMPTS; attempt++) {
		try {
			await args.append()
			return true
		} catch (error) {
			const giveUp = attempt === TERMINAL_APPEND_ATTEMPTS || args.pluginContext.closing
			args.logger.error(
				giveUp ? 'Could not persist upload terminal event' : 'Retrying upload terminal event append',
				error instanceof Error ? error : undefined,
				{ uploadId: args.uploadId, filename: args.filename, attempt },
			)
			if (giveUp) return false
			await new Promise<void>((resolve) => setTimeout(resolve, TERMINAL_APPEND_RETRY_DELAY_MS * attempt))
		}
	}
	return false
}

async function processUpload(args: {
	pluginContext: UploadsPluginContext
	prepared: PreparedUpload
	sessionId: SessionId
	upload: UploadDescriptor
	config: UploadsPluginConfig
	logger: Logger
	inferenceContext?: Omit<InferenceContext, 'signal'>
	onTerminal: (result: UploadResult) => Promise<void>
	/** Runs once the terminal status is durable in metadata, even if its event append failed. */
	onPersisted: (result: UploadResult) => Promise<void>
}): Promise<UploadResult> {
	const result = await runPreprocessor({
		uploadStore: args.prepared.uploadStore,
		filePath: args.prepared.filePath,
		mimeType: args.upload.mimeType,
		preprocessorRegistry: args.config.preprocessorRegistry,
		processingTimeoutMs: args.config.processingTimeoutMs,
		processingAbortGraceMs: args.config.processingAbortGraceMs,
		archiveLimits: args.config.archiveLimits,
		controller: args.prepared.lifecycle.controller,
		inferenceContext: args.inferenceContext,
	})
	await withUploadLock(args.pluginContext, args.prepared.uploadIdStr, async () => {
		if (args.pluginContext.deletedUploads.has(args.prepared.uploadIdStr)) return
		const metadata = createFinalMetadata({
			prepared: args.prepared,
			sessionId: args.sessionId,
			upload: args.upload,
			result,
		})
		await writeMetadata(args.prepared.uploadStore, metadata)
		if (args.pluginContext.closing) return
		const appended = await appendTerminalEvent({
			pluginContext: args.pluginContext,
			append: () => args.onTerminal(result),
			logger: args.logger,
			uploadId: args.prepared.uploadIdStr,
			filename: args.upload.filename,
		})
		if (appended) {
			metadata.terminalEventPersisted = true
			try {
				await writeMetadata(args.prepared.uploadStore, metadata)
			} catch (error) {
				// Only the flag write failed; the event is in the log, so onSessionReady reconciles the metadata.
				args.logger.error(
					'Could not record the upload terminal event flag',
					error instanceof Error ? error : undefined,
					{ uploadId: args.prepared.uploadIdStr, filename: args.upload.filename },
				)
			}
		}
		// The client has no polling fallback, so it is told either way — even when the event never landed.
		await args.onPersisted(result)
	}, { allowDuringClose: true })
	return result
}

function startAsyncUpload(args: {
	pluginContext: UploadsPluginContext
	prepared: PreparedUpload
	sessionId: SessionId
	upload: UploadDescriptor
	config: UploadsPluginConfig
	inferenceContext?: Omit<InferenceContext, 'signal'>
	emitEvent: SessionContext['emitEvent']
	notify: (type: 'uploadStatusChanged', payload: z.infer<typeof statusChangedSchema>) => void
	logger: Logger
	entryAgentId: AgentId | null
	scheduleAgent: (agentId: AgentId) => void
}): void {
	// start() rejects synchronously when `run` throws before its first await — that rejection needs a handler.
	void args.prepared.lifecycle.start(async () => {
		try {
			await processUpload({
				pluginContext: args.pluginContext,
				prepared: args.prepared,
				sessionId: args.sessionId,
				upload: args.upload,
				config: args.config,
				logger: args.logger,
				inferenceContext: args.inferenceContext,
				onTerminal: async (result) => {
					await args.emitEvent(createUploadResultEvent(args.upload, args.prepared.uploadId, result))
				},
				onPersisted: async (result) => {
					if (result.status === 'ready' && args.entryAgentId) args.scheduleAgent(args.entryAgentId)
					args.notify('uploadStatusChanged', {
						sessionId: String(args.sessionId),
						uploadId: args.prepared.uploadIdStr,
						status: result.status,
						error: result.error,
					})
				},
			})
		} catch (error) {
			args.logger.error('Async upload processing crashed', error instanceof Error ? error : undefined, {
				uploadId: args.prepared.uploadIdStr,
				filename: args.upload.filename,
			})
		}
	}).catch((error: unknown) => {
		args.logger.error('Async upload never started', error instanceof Error ? error : undefined, {
			uploadId: args.prepared.uploadIdStr,
			filename: args.upload.filename,
		})
	})
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
		initial: (): UploadsState => ({ pending: [], terminal: {} }),
		reduce: (state, event) => {
			switch (event.type) {
				case 'attachment_uploaded': {
					const pending = state.pending.filter((upload) => String(upload.uploadId) !== String(event.uploadId))
					if (event.status === 'processing') return { ...state, pending }
					const terminal = {
						...state.terminal,
						[String(event.uploadId)]: event.status,
					}
					if (event.status !== 'ready') return { ...state, pending, terminal }
					const upload: PendingUpload = {
						uploadId: event.uploadId,
						filename: event.filename,
						mimeType: event.mimeType,
						size: event.size,
						status: event.status,
						extractedContent: event.extractedContent,
						derivedPaths: event.derivedPaths,
					}
					return { ...state, pending: [...pending, upload], terminal }
				}
				case 'attachments_consumed': {
					const consumedIds = new Set(event.uploadIds.map(String))
					return {
						...state,
						pending: state.pending.filter((u) => !consumedIds.has(String(u.uploadId))),
						terminal: withoutKeys(state.terminal, [...consumedIds]),
					}
				}
				case 'attachment_deletion_completed': {
					const uploadId = String(event.uploadId)
					return {
						...state,
						pending: state.pending.filter((upload) => String(upload.uploadId) !== uploadId),
						terminal: withoutKeys(state.terminal, [uploadId]),
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
			activeMutations: new Map(),
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
			await runTrackedMutation({
				pluginContext: ctx.pluginContext,
				runtimeActivity: ctx.runtimeActivity,
				reason: 'uploads:consume',
				run: async () => {
					await ctx.emitEvent(
						uploadEvents.create('attachments_consumed', {
							agentId: ctx.agentId,
							uploadIds: token.map(UploadId),
						}),
					)

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
						}, { allowDuringClose: true })
					}
				},
			})
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
			uploadId: uploadIdSchema,
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const { dataFileStore } = ctx.pluginConfig
			const uploadStore = dataFileStore.scoped(`sessions/${input.sessionId}/uploads/${input.uploadId}`)
			try {
				return await runTrackedMutation({
					pluginContext: ctx.pluginContext,
					runtimeActivity: ctx.runtimeActivity,
					reason: `upload:${input.uploadId}:delete`,
					run: async () => {
						let releaseTerminalHold: RuntimeLeaseRelease | undefined
						try {
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
								releaseTerminalHold = active?.holdTerminalMutation()
								active?.controller.abort(new Error('Upload deleted'))
								return Ok(active?.processingCompletion)
							}, { allowDuringClose: true })
							if (!reservation.ok) return reservation
							await reservation.value

							return await withUploadLock(ctx.pluginContext, input.uploadId, async () => {
								const metaResult = await uploadStore.read('meta.json')
								if (!metaResult.ok) return Err(ValidationErrors.invalid(`Upload not found: ${input.uploadId}`))
								const meta: UploadMetadata = JSON.parse(metaResult.value)
								meta.status = 'deleted'
								await writeMetadata(uploadStore, meta)
								const cleanup = await removeUploadFiles(uploadStore)
								if (!cleanup.ok) return Err(ValidationErrors.invalid(`Could not remove upload: ${input.uploadId}`))
								await ctx.emitEvent(
									uploadEvents.create('attachment_deletion_completed', {
										uploadId: input.uploadId,
									}),
								)
								return Ok({})
							}, { allowDuringClose: true })
						} finally {
							ctx.pluginContext.deletedUploads.delete(input.uploadId)
							releaseTerminalHold?.()
						}
					},
				})
			} catch (error) {
				return Err(ValidationErrors.invalid(error instanceof Error ? error.message : 'Could not delete upload'))
			}
		},
	})
	.method('loadAttachments', {
		input: z.object({
			sessionId: z.string(),
			uploadIds: z.array(uploadIdSchema),
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
			// The id lands in a path, so it is validated here rather than inside the loop below.
			uploadIds: z.array(uploadIdSchema),
			messageId: z.string(),
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const { dataFileStore } = ctx.pluginConfig
			try {
				return await runTrackedMutation({
					pluginContext: ctx.pluginContext,
					runtimeActivity: ctx.runtimeActivity,
					reason: 'uploads:mark-used',
					run: async () => {
						const successfulIds: string[] = []
						const emitSuccessfulConsumption = async () => {
							if (successfulIds.length === 0) return
							await ctx.emitEvent(
								uploadEvents.create('attachments_consumed', {
									agentId: getEntryAgentId(ctx.sessionState) ?? 'uploads.markUsed',
									uploadIds: successfulIds.map(UploadId),
								}),
							)
						}

						for (const uploadIdStr of input.uploadIds) {
							let result: Result<Record<string, never>, ReturnType<typeof ValidationErrors.invalid>>
							try {
								result = await withUploadLock(ctx.pluginContext, uploadIdStr, async () => {
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
								}, { allowDuringClose: true })
							} catch (error) {
								await emitSuccessfulConsumption()
								throw error
							}
							if (!result.ok) {
								await emitSuccessfulConsumption()
								return result
							}
							successfulIds.push(uploadIdStr)
						}
						await emitSuccessfulConsumption()
						return Ok({})
					},
				})
			} catch (error) {
				return Err(ValidationErrors.invalid(error instanceof Error ? error.message : 'Could not mark upload as used'))
			}
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
				logger: ctx.logger,
				input,
			})
			if (!preparedResult.ok) return Err(preparedResult.error)
			const prepared = preparedResult.value
			// Built from the stored name, not from `input`: the metadata and the event tell the agent
			// where the file is, and a spelling that differs from the directory entry is unusable.
			const upload: UploadDescriptor = {
				filename: prepared.filename,
				mimeType: input.mimeType,
				size: input.size,
			}
			const entryAgentId = getEntryAgentId(ctx.sessionState)
			try {
				const result = await prepared.lifecycle.start(() =>
					processUpload({
						pluginContext: ctx.pluginContext,
						prepared,
						sessionId: ctx.sessionId,
						upload,
						config: ctx.pluginConfig,
						logger: ctx.logger,
						inferenceContext: entryAgentId
							? {
									sessionId: String(ctx.sessionId),
									agentId: String(entryAgentId),
									fileStore: ctx.files,
								}
							: undefined,
						onTerminal: async (finalResult) => {
							await ctx.emitEvent(createUploadResultEvent(upload, prepared.uploadId, finalResult))
						},
						onPersisted: async (finalResult) => {
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
				logger: ctx.logger,
				input,
			})
			if (!preparedResult.ok) return Err(preparedResult.error)
			const prepared = preparedResult.value
			// Built from the stored name, not from `input`: the metadata and the event tell the agent
			// where the file is, and a spelling that differs from the directory entry is unusable.
			const upload: UploadDescriptor = {
				filename: prepared.filename,
				mimeType: input.mimeType,
				size: input.size,
			}
			const processingMeta: UploadMetadata = {
				uploadId: prepared.uploadId,
				sessionId: ctx.sessionId,
				filename: upload.filename,
				mimeType: upload.mimeType,
				size: upload.size,
				path: prepared.filePath,
				status: 'processing',
				createdAt: prepared.createdAt,
			}
			try {
				await writeMetadata(prepared.uploadStore, processingMeta)
				await ctx.emitEvent(
					uploadEvents.create('attachment_uploaded', {
						uploadId: prepared.uploadId,
						filename: upload.filename,
						mimeType: upload.mimeType,
						size: upload.size,
						status: 'processing',
					}),
				)
			} catch (error) {
				prepared.lifecycle.abandon()
				return Err(ValidationErrors.invalid(error instanceof Error ? error.message : 'Could not start upload'))
			}
			try {
				const releaseRuntimeLease = ctx.runtimeActivity.acquire(`upload:${prepared.uploadIdStr}:processing`)
				prepared.lifecycle.attachRuntimeLease(releaseRuntimeLease)
			} catch (error) {
				prepared.lifecycle.abandon()
				return Err(ValidationErrors.invalid(error instanceof Error ? error.message : 'Could not start upload'))
			}
			// Everything from here to startAsyncUpload must be guarded: the lifecycle
			// only settles once lifecycle.start() runs, so a throw before it leaks the
			// runtime lease AND hangs onSessionClose, which awaits this completion.
			// ctx.notify is the realistic trigger — it reaches embedder-supplied
			// onUserOutput, which in standalone/sandbox writes to sockets.
			try {
				ctx.notify('uploadStatusChanged', {
					sessionId: input.sessionId,
					uploadId: prepared.uploadIdStr,
					status: 'processing',
				})

				const sessionId = ctx.sessionId
				const sessionIdString = String(sessionId)
				const entryAgentId = getEntryAgentId(ctx.sessionState)
				const inferenceContext = entryAgentId
					? {
							sessionId: sessionIdString,
							agentId: String(entryAgentId),
							fileStore: ctx.files,
						}
					: undefined
				startAsyncUpload({
					pluginContext: ctx.pluginContext,
					prepared,
					sessionId,
					upload,
					config: ctx.pluginConfig,
					inferenceContext,
					emitEvent: ctx.emitEvent,
					notify: ctx.notify,
					logger: ctx.logger,
					entryAgentId,
					scheduleAgent: ctx.scheduleAgent,
				})
			} catch (error) {
				prepared.lifecycle.abandon()
				return Err(ValidationErrors.invalid(error instanceof Error ? error.message : 'Could not start upload'))
			}

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
		const seenUploadIds = new Set<string>()

		for (const entry of listResult.value) {
			if (entry.type !== 'directory') continue
			seenUploadIds.add(entry.name)
			const uploadStore = ctx.pluginConfig.dataFileStore.scoped(`${uploadsPath}/${entry.name}`)
			try {
				const metaResult = await uploadStore.read('meta.json')
				if (!metaResult.ok) continue
				const metadata: UploadMetadata = JSON.parse(metaResult.value)
				if (String(metadata.sessionId) !== String(ctx.sessionId)) continue
				// The agent can write into the upload dir, and this id becomes a path handed back to it.
				const parsedUploadId = parseUploadId(String(metadata.uploadId))
				if (!parsedUploadId.ok) {
					ctx.logger.warn('Skipping upload metadata with an invalid upload id', { entry: entry.name })
					continue
				}
				const uploadId = String(parsedUploadId.value)
				seenUploadIds.add(uploadId)
				const projection = ctx.pluginState.terminal[uploadId]
				if (metadata.usedInMessageId) {
					if (projection) {
						await ctx.emitEvent(uploadEvents.create('attachments_consumed', {
							agentId: 'uploads.recovery',
							uploadIds: [metadata.uploadId],
						}))
					}
					continue
				}
				if (metadata.status === 'deleted') {
					if (projection) {
						await ctx.emitEvent(uploadEvents.create('attachment_deletion_completed', { uploadId: metadata.uploadId }))
					}
					continue
				}
				if (projection) {
					if (metadata.status !== projection || !metadata.terminalEventPersisted) {
						metadata.status = projection
						// createFinalMetadata already wrote result.error before the terminal event.
						metadata.error = projection === 'failed' ? metadata.error ?? 'Processing failed' : undefined
						if (projection === 'ready') {
							const pending = ctx.pluginState.pending.find((upload) => String(upload.uploadId) === uploadId)
							if (!pending) throw new Error('Ready terminal event has no pending projection')
							metadata.extractedContent = pending.extractedContent
							metadata.derivedPaths = pending.derivedPaths
						} else {
							metadata.extractedContent = undefined
							metadata.derivedPaths = undefined
						}
						metadata.completedAt ??= Date.now()
						metadata.terminalEventPersisted = true
						await writeMetadata(uploadStore, metadata)
					}
					continue
				}
				if (metadata.terminalEventPersisted) continue

				if (metadata.status === 'processing') {
					metadata.status = 'failed'
					metadata.error = 'Processing interrupted by restart'
					metadata.completedAt = Date.now()
					await writeMetadata(uploadStore, metadata)
				}
				const result: UploadResult = metadata.status === 'ready'
					? {
							status: 'ready',
							extractedContent: metadata.extractedContent,
							derivedPaths: metadata.derivedPaths,
						}
					: { status: 'failed', error: metadata.error }
				const recoveredUpload: UploadDescriptor = {
					filename: metadata.filename,
					mimeType: metadata.mimeType,
					size: metadata.size,
				}
				await ctx.emitEvent(createUploadResultEvent(recoveredUpload, metadata.uploadId, result))
				metadata.terminalEventPersisted = true
				await writeMetadata(uploadStore, metadata)
				ctx.notify('uploadStatusChanged', {
					sessionId: String(ctx.sessionId),
					uploadId,
					status: result.status,
					error: result.error,
				})
			} catch (error) {
				ctx.logger.warn('Could not recover interrupted upload', {
					uploadId: entry.name,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
		// A fork copies the event log but not the uploads dir, so every inherited upload looks
		// orphaned here — sweeping them would delete attachments the fork still shows.
		if (ctx.sessionState.forkedFrom) return
		for (const uploadId of Object.keys(ctx.pluginState.terminal)) {
			if (seenUploadIds.has(uploadId)) continue
			await ctx.emitEvent(uploadEvents.create('attachment_deletion_completed', { uploadId: UploadId(uploadId) }))
		}
	})
	.sessionHook('onSessionClose', async (ctx) => {
		ctx.pluginContext.closing = true
		const active = [...ctx.pluginContext.activeUploads.values()]
		for (const upload of active) upload.controller.abort(new Error('Session is closing'))
		const configuredDrainTimeoutMs = ctx.pluginConfig.closeDrainTimeoutMs
		const settled = await settleWithTimeout(
			[...active.map((upload) => upload.completion), ...ctx.pluginContext.activeMutations.keys()],
			configuredDrainTimeoutMs !== undefined && configuredDrainTimeoutMs > 0 ? configuredDrainTimeoutMs : CLOSE_DRAIN_TIMEOUT_MS,
		)
		if (!settled) {
			// Releasing the manager's map entry is not the same as freeing the session: a wedged lifecycle
			// still holds emitEvent/notify/scheduleAgent closures, so the runtime graph outlives disposal
			// until it settles — bounded here only so disposal itself never hangs on it.
			ctx.logger.warn('Upload lifecycles did not settle before close', {
				sessionId: String(ctx.sessionId),
				reason: ctx.reason,
				pendingUploadIds: [...ctx.pluginContext.activeUploads.keys()],
				pendingMutations: [...ctx.pluginContext.activeMutations.values()],
			})
		}
		ctx.pluginContext.activeUploads.clear()
		ctx.pluginContext.activeMutations.clear()
		if (settled) {
			// Work that outlived the drain still reads these: clearing them un-guards a deleted upload
			// against its own processUpload and drops the lock that keeps the two ordered.
			ctx.pluginContext.deletedUploads.clear()
			ctx.pluginContext.operationQueues.clear()
		}
	})
	.build()
