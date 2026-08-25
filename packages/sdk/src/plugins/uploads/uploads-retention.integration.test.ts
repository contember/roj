import { describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import z from 'zod/v4'
import { MemoryEventStore } from '~/core/events/memory.js'
import type { DomainEvent } from '~/core/events/types.js'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import type { FileEntry, FileStore } from '~/core/file-store/types.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { SessionManager } from '~/core/sessions/session-manager.js'
import { ToolExecutor } from '~/core/tools/executor.js'
import type { LogContext, Logger } from '~/lib/logger/logger.js'
import { Err, Ok, type Result } from '~/lib/utils/result.js'
import { createTestPreset, TestHarness, TestSession } from '~/testing/index.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { type UploadsPluginConfig, uploadsPlugin } from './plugin.js'
import type { Preprocessor, PreprocessorContext } from './preprocessor.js'
import { PreprocessorRegistry } from './preprocessor.js'
import { generateUploadId, UploadId } from './schema.js'
import type { UploadsState } from './state.js'
import { uploadEvents } from './state.js'

const asyncUploadSchema = z.object({
	uploadId: z.string(),
	status: z.literal('processing'),
})

const syncUploadSchema = z.object({
	uploadId: z.string(),
	status: z.enum(['ready', 'failed']),
})

const statusChangedSchema = z.object({
	uploadId: z.string(),
	status: z.enum(['processing', 'ready', 'failed']),
})

const usedMetadataSchema = z.object({
	usedInMessageId: z.string().optional(),
})

const terminalMetadataSchema = z.object({
	status: z.enum(['processing', 'ready', 'failed', 'deleted']),
	terminalEventPersisted: z.boolean().optional(),
})

function okValue<T>(result: { ok: boolean; value?: unknown }, schema: z.ZodType<T>): T {
	expect(result.ok).toBe(true)
	if (!result.ok) throw new Error('Expected ok result')
	return schema.parse(result.value)
}

function createPreset(config: Omit<UploadsPluginConfig, 'dataFileStore'>) {
	return createTestPreset({
		plugins: [{ pluginName: 'uploads', definition: uploadsPlugin, config }],
	})
}

function registryWith(preprocessor: Preprocessor): PreprocessorRegistry {
	const registry = new PreprocessorRegistry()
	registry.register(preprocessor)
	return registry
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {}
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

/** Fault injection and the write journal, shared by every store derived from one root via scoped()/session. */
interface StoreFaults {
	failedReads: Set<string>
	writeFaults: Map<string, { mode: 'throw' | 'err'; message: string }>
	writes: Array<{ path: string; content: string }>
}

const createStoreFaults = (): StoreFaults => ({ failedReads: new Set(), writeFaults: new Map(), writes: [] })

class SelectiveFailureStore implements FileStore {
	constructor(
		private readonly delegate: FileStore,
		readonly faults: StoreFaults = createStoreFaults(),
		private readonly prefix = '',
	) {}

	failRead(path: string): void {
		this.faults.failedReads.add(path)
	}

	/** Throws instead of returning Err — the fs failure mode FileStore cannot map (ENOSPC, EROFS, NUL byte). */
	throwOnWrite(name: string, message?: string): void {
		this.faults.writeFaults.set(name, { mode: 'throw', message: message ?? `Injected write failure: ${name}` })
	}

	/** Returns Err — the failure mode a well-behaved FileStore reports. */
	failWrite(name: string, message?: string): void {
		this.faults.writeFaults.set(name, { mode: 'err', message: message ?? `Injected write error: ${name}` })
	}

	/** Every write in order, so a test can assert what a racing operation wrote and when. */
	writtenPaths(suffix: string): Array<{ path: string; content: string }> {
		return this.faults.writes.filter((write) => write.path.endsWith(suffix))
	}

	write(path: string, content: string | Buffer): Promise<Result<{ path: string }, string>> {
		const fault = this.faults.writeFaults.get(path.split('/').pop() ?? path)
		if (fault?.mode === 'throw') throw new Error(fault.message)
		if (fault?.mode === 'err') return Promise.resolve(Err(fault.message))
		this.faults.writes.push({ path: this.prefix ? `${this.prefix}/${path}` : path, content: content.toString() })
		return this.delegate.write(path, content)
	}

	read(path: string): Promise<Result<string, string>>
	read(path: string, opts: { type: 'buffer' }): Promise<Result<Buffer, string>>
	read(path: string, opts?: { type: 'buffer' }): Promise<Result<string, string> | Result<Buffer, string>> {
		const fullPath = this.prefix ? `${this.prefix}/${path}` : path
		if (this.faults.failedReads.has(fullPath)) return Promise.resolve(Err('Injected read failure'))
		if (opts) return this.delegate.read(path, opts)
		return this.delegate.read(path)
	}

	exists(path: string): Promise<Result<boolean, string>> {
		return this.delegate.exists(path)
	}

	stat(path: string): Promise<Result<FileEntry, string>> {
		return this.delegate.stat(path)
	}

	list(path: string, options?: { maxDepth?: number; gitIgnore?: boolean }): Promise<Result<FileEntry[], string>> {
		return this.delegate.list(path, options)
	}

	remove(path: string): Promise<Result<void, string>> {
		return this.delegate.remove(path)
	}

	realPath(path: string): Result<string, string> {
		return this.delegate.realPath(path)
	}

	getRoots(): { session: string; workspace?: string } {
		return this.delegate.getRoots()
	}

	scoped(subPath: string): FileStore {
		const prefix = this.prefix ? `${this.prefix}/${subPath}` : subPath
		return new SelectiveFailureStore(this.delegate.scoped(subPath), this.faults, prefix)
	}

	get session(): FileStore {
		return new SelectiveFailureStore(this.delegate.session, this.faults, this.prefix)
	}

	get workspace(): FileStore | undefined {
		const workspace = this.delegate.workspace
		return workspace ? new SelectiveFailureStore(workspace, this.faults, this.prefix) : undefined
	}
}

/** Records warnings so a test can assert what the close-drain warning actually named. */
class CapturingLogger implements Logger {
	readonly level = 'debug' as const
	readonly warns: Array<{ message: string; context?: LogContext }> = []

	debug(): void {}
	info(): void {}

	warn(message: string, context?: LogContext): void {
		this.warns.push({ message, context })
	}

	error(): void {}

	child(): Logger {
		return this
	}
}

/** Rejects the next `terminalFailuresLeft` terminal `attachment_uploaded` appends. */
class FailTerminalEventStore extends MemoryEventStore {
	terminalFailuresLeft = 0

	protected override async doAppend(sessionId: SessionId, event: DomainEvent): Promise<void> {
		const parsed = z.object({ status: z.string() }).safeParse(event)
		if (this.terminalFailuresLeft > 0 && event.type === 'attachment_uploaded' && parsed.success && parsed.data.status !== 'processing') {
			this.terminalFailuresLeft--
			throw new Error('Injected terminal append failure')
		}
		await super.doAppend(sessionId, event)
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

function uploadLeaseCount(harness: TestHarness, uploadId: string): number {
	const reason = `upload:${uploadId}:processing`
	return harness.sessionManager.getRuntimeCacheStats().sessions[0]?.leaseReasons[reason] ?? 0
}

async function waitForTerminal(
	harness: TestHarness,
	uploadId: string,
	expectedStatus: 'ready' | 'failed',
	opts?: { timeoutMs?: number },
): Promise<void> {
	await harness.notifications.waitFor((notification) => {
		if (notification.pluginName !== 'uploads' || notification.type !== 'uploadStatusChanged') return false
		const parsed = statusChangedSchema.safeParse(notification.payload)
		return parsed.success && parsed.data.uploadId === uploadId && parsed.data.status === expectedStatus
	}, opts)
}

/** Resolves 'hung' when `work` outlives the bound, so a regression fails the assertion instead of the suite. */
async function raceDeadline<T extends string>(work: Promise<T>, timeoutMs: number): Promise<T | 'hung'> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([work, new Promise<'hung'>((resolve) => {
			timeoutId = setTimeout(() => resolve('hung'), timeoutMs)
		})])
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId)
	}
}

function abortablePreprocessor(
	started: ReturnType<typeof deferred>,
	options?: { aborted?: ReturnType<typeof deferred>; cleanupGate?: ReturnType<typeof deferred> },
): Preprocessor {
	return {
		name: 'abortable',
		supportedMimeTypes: ['text/plain'],
		process: async (_filePath: string, _mimeType: string, ctx: PreprocessorContext) => {
			started.resolve()
			const signal = ctx.signal
			if (!signal) throw new Error('Expected preprocessing signal')
			await new Promise<void>((resolve) => {
				if (signal.aborted) {
					resolve()
					return
				}
				signal.addEventListener('abort', () => resolve(), { once: true })
			})
			options?.aborted?.resolve()
			await options?.cleanupGate?.promise
			return Err(new Error('Processing cancelled'))
		},
	}
}

describe('uploads runtime retention', () => {
	it('holds one runtime lease during async preprocessing and releases it after ready materialization', async () => {
		const started = deferred()
		const processingGate = deferred()
		const preprocessor: Preprocessor = {
			name: 'gated-success',
			supportedMimeTypes: ['text/plain'],
			process: async () => {
				started.resolve()
				await processingGate.promise
				return Ok({ extractedContent: 'large extracted content' })
			},
		}
		const harness = new TestHarness({
			presets: [createPreset({ preprocessorRegistry: registryWith(preprocessor) })],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		})

		try {
			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Keep upload pending')

			const fileBuffer = Buffer.alloc(1024 * 1024, 1)
			const upload = okValue(
				await session.callPluginMethod('uploads.uploadAsync', {
					sessionId: String(session.sessionId),
					filename: 'gated.txt',
					mimeType: 'text/plain',
					size: fileBuffer.length,
					fileBuffer,
				}),
				asyncUploadSchema,
			)
			await started.promise

			expect(uploadLeaseCount(harness, upload.uploadId)).toBe(1)
			processingGate.resolve()
			await waitForTerminal(harness, upload.uploadId, 'ready')
			await waitUntil(() => uploadLeaseCount(harness, upload.uploadId) === 0)
			const terminalNotification = harness.notifications.getByType('uploads', 'uploadStatusChanged').find((notification) => {
				const parsed = statusChangedSchema.safeParse(notification.payload)
				return parsed.success && parsed.data.uploadId === upload.uploadId && parsed.data.status === 'ready'
			})
			expect(terminalNotification).toBeDefined()
			const terminalPayload = terminalNotification?.payload
			if (typeof terminalPayload !== 'object' || terminalPayload === null) throw new Error('Expected terminal notification payload')
			expect('extractedContent' in terminalPayload).toBe(false)

			const pending = session.getPluginState<UploadsState>('uploads')?.pending
			expect(pending).toHaveLength(1)
			expect(pending?.[0]?.extractedContent).toBe('large extracted content')

			await session.callPluginMethod('uploads.markUsed', {
				sessionId: String(session.sessionId),
				uploadIds: [upload.uploadId],
				messageId: 'message-1',
			})
			const consumedState = session.getPluginState<UploadsState>('uploads')
			expect(consumedState?.pending).toHaveLength(0)
			expect(consumedState?.terminal[upload.uploadId]).toBeUndefined()
		} finally {
			await harness.shutdown()
		}
	})

	it('releases the async runtime lease when the notification sink throws', async () => {
		const preprocessor: Preprocessor = {
			name: 'never-runs',
			supportedMimeTypes: ['text/plain'],
			process: async () => Ok({ extractedContent: 'unused' }),
		}
		const harness = new TestHarness({
			presets: [createPreset({ preprocessorRegistry: registryWith(preprocessor) })],
			// A hostile embedder: in standalone/sandbox this callback writes to sockets.
			onUserOutput: (notification) => {
				if (notification.type === 'uploadStatusChanged') throw new Error('broadcast failed')
			},
		})

		try {
			const session = await harness.createSession('test')
			const result = await session.callPluginMethod('uploads.uploadAsync', {
				sessionId: String(session.sessionId),
				filename: 'hostile.txt',
				mimeType: 'text/plain',
				size: 4,
				fileBuffer: Buffer.from('data'),
			})

			expect(result.ok).toBe(false)
			// The lifecycle must settle even though start() never ran — otherwise the
			// lease pins the runtime and onSessionClose awaits a promise that never resolves.
			const leases = harness.sessionManager.getRuntimeCacheStats().sessions[0]?.leaseReasons ?? {}
			expect(Object.keys(leases).filter((reason) => reason.startsWith('upload:'))).toEqual([])
		} finally {
			// Hangs instead of failing if the lifecycle never settled.
			await harness.shutdown()
		}
	})

	it('releases the async runtime lease after preprocessing failure', async () => {
		const started = deferred()
		const processingGate = deferred()
		const preprocessor: Preprocessor = {
			name: 'gated-failure',
			supportedMimeTypes: ['text/plain'],
			process: async () => {
				started.resolve()
				await processingGate.promise
				return Err(new Error('Extraction failed'))
			},
		}
		const harness = new TestHarness({ presets: [createPreset({ preprocessorRegistry: registryWith(preprocessor) })] })

		try {
			const session = await harness.createSession('test')
			const upload = okValue(
				await session.callPluginMethod('uploads.uploadAsync', {
					sessionId: String(session.sessionId),
					filename: 'failure.txt',
					mimeType: 'text/plain',
					size: 4,
					fileBuffer: Buffer.from('fail'),
				}),
				asyncUploadSchema,
			)
			await started.promise
			expect(uploadLeaseCount(harness, upload.uploadId)).toBe(1)

			processingGate.resolve()
			await waitForTerminal(harness, upload.uploadId, 'failed')
			await waitUntil(() => uploadLeaseCount(harness, upload.uploadId) === 0)
			const failedState = session.getPluginState<UploadsState>('uploads')
			expect(failedState?.pending).toHaveLength(0)
			expect(failedState?.terminal[upload.uploadId]).toBe('failed')
		} finally {
			await harness.shutdown()
		}
	})

	it('releases the async runtime lease after timeout', async () => {
		const started = deferred()
		const preprocessor: Preprocessor = {
			name: 'ignores-abort',
			supportedMimeTypes: ['text/plain'],
			process: async () => {
				started.resolve()
				await new Promise<void>(() => {})
				return Ok({})
			},
		}
		const harness = new TestHarness({
			presets: [createPreset({
				preprocessorRegistry: registryWith(preprocessor),
				processingTimeoutMs: 5,
				processingAbortGraceMs: 5,
			})],
		})

		try {
			const session = await harness.createSession('test')
			const upload = okValue(
				await session.callPluginMethod('uploads.uploadAsync', {
					sessionId: String(session.sessionId),
					filename: 'timeout.txt',
					mimeType: 'text/plain',
					size: 7,
					fileBuffer: Buffer.from('timeout'),
				}),
				asyncUploadSchema,
			)
			await started.promise
			expect(uploadLeaseCount(harness, upload.uploadId)).toBe(1)

			await waitForTerminal(harness, upload.uploadId, 'failed')
			await waitUntil(() => uploadLeaseCount(harness, upload.uploadId) === 0)
		} finally {
			await harness.shutdown()
		}
	})

	it('aborts a deleted async upload and releases its runtime lease', async () => {
		const started = deferred()
		const harness = new TestHarness({
			presets: [createPreset({ preprocessorRegistry: registryWith(abortablePreprocessor(started)) })],
		})

		try {
			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Keep upload pending')
			const upload = okValue(
				await session.callPluginMethod('uploads.uploadAsync', {
					sessionId: String(session.sessionId),
					filename: 'delete.txt',
					mimeType: 'text/plain',
					size: 6,
					fileBuffer: Buffer.from('delete'),
				}),
				asyncUploadSchema,
			)
			await started.promise
			expect(uploadLeaseCount(harness, upload.uploadId)).toBe(1)

			const deleted = await session.callPluginMethod('uploads.delete', {
				sessionId: String(session.sessionId),
				uploadId: upload.uploadId,
			})
			expect(deleted.ok).toBe(true)
			await waitUntil(() => uploadLeaseCount(harness, upload.uploadId) === 0)
			const deletedState = session.getPluginState<UploadsState>('uploads')
			expect(deletedState?.pending).toHaveLength(0)
			expect(deletedState?.terminal[upload.uploadId]).toBeUndefined()
		} finally {
			await harness.shutdown()
		}
	})

	it('aborts active uploads and releases their leases during session close', async () => {
		const started = deferred()
		const harness = new TestHarness({
			presets: [createPreset({ preprocessorRegistry: registryWith(abortablePreprocessor(started)) })],
		})

		const session = await harness.createSession('test')
		const upload = okValue(
			await session.callPluginMethod('uploads.uploadAsync', {
				sessionId: String(session.sessionId),
				filename: 'close.txt',
				mimeType: 'text/plain',
				size: 5,
				fileBuffer: Buffer.from('close'),
			}),
			asyncUploadSchema,
		)
		await started.promise
		expect(uploadLeaseCount(harness, upload.uploadId)).toBe(1)

		await harness.shutdown()
		expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
	})

	it('replays a log that still carries the removed attachment_terminal_materialized event', async () => {
		// Dev and staging ran this branch before the event type was dropped, so their
		// logs still contain it. Reducers switch on event.type with a default passthrough
		// and nothing validates event types on load, so the orphan must be inert.
		const eventStore = new MemoryEventStore()
		const preset = createPreset({})
		const source = new TestHarness({ presets: [preset], eventStore })
		let sessionId: SessionId

		try {
			const session = await source.createSession('test')
			sessionId = session.sessionId
			await eventStore.append(sessionId, {
				type: 'attachment_terminal_materialized',
				sessionId,
				timestamp: Date.now(),
				uploadId: UploadId(generateUploadId()),
			} as unknown as DomainEvent)
		} finally {
			await source.shutdown()
		}

		const recovered = new TestHarness({ presets: [preset], eventStore })
		try {
			const session = await recovered.openSession(sessionId)
			expect(session.getPluginState<UploadsState>('uploads')?.terminal).toEqual({})
		} finally {
			await recovered.shutdown()
		}
	})

	it('persists terminal metadata during close without late events or notifications', async () => {
		const basePath = `/tmp/roj-upload-close-${crypto.randomUUID()}`
		const platform = createNodePlatform()
		const dataFileStore = new SessionFileStore(basePath, undefined, false, platform.fs, 'session')
		const eventStore = new MemoryEventStore()
		const started = deferred()
		const preset = createTestPreset({
			plugins: [uploadsPlugin.configure({
				dataFileStore,
				preprocessorRegistry: registryWith(abortablePreprocessor(started)),
			})],
		})
		const source = new TestHarness({ presets: [preset], eventStore })
		let recovered: TestHarness | undefined

		try {
			const session = await source.createSession('test')
			const upload = okValue(
				await session.callPluginMethod('uploads.uploadAsync', {
					sessionId: String(session.sessionId),
					filename: 'close-durable.txt',
					mimeType: 'text/plain',
					size: 13,
					fileBuffer: Buffer.from('close-durable'),
				}),
				asyncUploadSchema,
			)
			await started.promise
			await source.shutdown()

			const metaResult = await dataFileStore.read(`sessions/${session.sessionId}/uploads/${upload.uploadId}/meta.json`)
			expect(metaResult.ok).toBe(true)
			if (!metaResult.ok) throw new Error('Expected upload metadata')
			const metadata = terminalMetadataSchema.parse(JSON.parse(metaResult.value))
			expect(metadata.status).toBe('failed')
			expect(metadata.terminalEventPersisted).not.toBe(true)
			const sourceEvents = await session.getEventsByType(uploadEvents, 'attachment_uploaded')
			expect(sourceEvents.filter((event) => String(event.uploadId) === upload.uploadId && event.status === 'failed')).toHaveLength(0)
			const sourceTerminalNotifications = source.notifications.getByType('uploads', 'uploadStatusChanged').filter((notification) => {
				const parsed = statusChangedSchema.safeParse(notification.payload)
				return parsed.success && parsed.data.uploadId === upload.uploadId && parsed.data.status === 'failed'
			})
			expect(sourceTerminalNotifications).toHaveLength(0)

			recovered = new TestHarness({ presets: [preset], eventStore })
			const recoveredSession = await recovered.openSession(session.sessionId)
			const recoveredEvents = await recoveredSession.getEventsByType(uploadEvents, 'attachment_uploaded')
			expect(recoveredEvents.filter((event) => String(event.uploadId) === upload.uploadId && event.status === 'failed')).toHaveLength(1)
		} finally {
			await source.shutdown()
			await recovered?.shutdown()
			await rm(basePath, { recursive: true, force: true })
		}
	})

	it('keeps delete lifecycle and shutdown pending through abort cleanup and deletion durability', async () => {
		const deletionEventStarted = deferred()
		const allowDeletionEvent = deferred()
		class GatedDeletionEventStore extends MemoryEventStore {
			protected override async doAppend(sessionId: SessionId, event: DomainEvent): Promise<void> {
				if (event.type === 'attachment_deletion_completed') {
					deletionEventStarted.resolve()
					await allowDeletionEvent.promise
				}
				await super.doAppend(sessionId, event)
			}
		}

		const started = deferred()
		const aborted = deferred()
		const cleanupGate = deferred()
		const eventStore = new GatedDeletionEventStore()
		const harness = new TestHarness({
			presets: [createPreset({
				preprocessorRegistry: registryWith(abortablePreprocessor(started, { aborted, cleanupGate })),
			})],
			eventStore,
		})
		let shutdown: Promise<void> | undefined

		try {
			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Keep upload pending')
			const upload = okValue(
				await session.callPluginMethod('uploads.uploadAsync', {
					sessionId: String(session.sessionId),
					filename: 'delete-close.txt',
					mimeType: 'text/plain',
					size: 12,
					fileBuffer: Buffer.from('delete-close'),
				}),
				asyncUploadSchema,
			)
			await started.promise

			let deleteSettled = false
			const deletion = session.callPluginMethod('uploads.delete', {
				sessionId: String(session.sessionId),
				uploadId: upload.uploadId,
			}).then((result) => {
				deleteSettled = true
				return result
			})
			await aborted.promise
			expect(deleteSettled).toBe(false)
			expect(uploadLeaseCount(harness, upload.uploadId)).toBe(1)
			expect(harness.sessionManager.getRuntimeCacheStats().sessions[0]?.leaseReasons[`upload:${upload.uploadId}:delete`]).toBe(1)
			let shutdownSettled = false
			shutdown = harness.shutdown().then(() => {
				shutdownSettled = true
			})
			await new Promise((resolve) => setTimeout(resolve, 5))
			expect(shutdownSettled).toBe(false)

			cleanupGate.resolve()
			await deletionEventStarted.promise
			expect(deleteSettled).toBe(false)
			expect(uploadLeaseCount(harness, upload.uploadId)).toBe(1)
			expect(shutdownSettled).toBe(false)

			allowDeletionEvent.resolve()
			const deletionResult = await deletion
			expect(deletionResult.ok).toBe(true)
			await shutdown
			const eventCountAfterClose = eventStore.getEventCount(session.sessionId)
			await new Promise((resolve) => setTimeout(resolve, 5))
			expect(eventStore.getEventCount(session.sessionId)).toBe(eventCountAfterClose)
		} finally {
			cleanupGate.resolve()
			allowDeletionEvent.resolve()
			await shutdown
			if (!shutdown) await harness.shutdown()
		}
	})

	it('materializes a successful markUsed prefix when a later upload fails', async () => {
		const basePath = `/tmp/roj-upload-mark-used-${crypto.randomUUID()}`
		const platform = createNodePlatform()
		const dataFileStore = new SessionFileStore(basePath, undefined, false, platform.fs, 'session')
		const preset = createTestPreset({ plugins: [uploadsPlugin.configure({ dataFileStore })] })
		const harness = new TestHarness({
			presets: [preset],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		})

		try {
			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Prepare partial batch')
			const first = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'first.txt',
					mimeType: 'text/plain',
					size: 5,
					fileBuffer: Buffer.from('first'),
				}),
				syncUploadSchema,
			)
			const second = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'second.txt',
					mimeType: 'text/plain',
					size: 6,
					fileBuffer: Buffer.from('second'),
				}),
				syncUploadSchema,
			)
			const secondStore = dataFileStore.scoped(`sessions/${session.sessionId}/uploads/${second.uploadId}`)
			expect((await secondStore.remove('meta.json')).ok).toBe(true)

			const marked = await session.callPluginMethod('uploads.markUsed', {
				sessionId: String(session.sessionId),
				uploadIds: [first.uploadId, second.uploadId],
				messageId: 'partial-message',
			})
			expect(marked.ok).toBe(false)
			const pendingIds = session.getPluginState<UploadsState>('uploads')?.pending.map((upload) => String(upload.uploadId))
			expect(pendingIds).toEqual([second.uploadId])

			const firstMeta = await dataFileStore.read(`sessions/${session.sessionId}/uploads/${first.uploadId}/meta.json`)
			expect(firstMeta.ok).toBe(true)
			if (!firstMeta.ok) throw new Error('Expected first metadata')
			expect(usedMetadataSchema.parse(JSON.parse(firstMeta.value)).usedInMessageId).toBe('partial-message')

			await session.resumeAgent(entryAgentId)
			await session.waitForIdle()
			const requestText = harness.llmProvider.getLastRequest()?.messages
				.map((message) => typeof message.content === 'string' ? message.content : '')
				.join('\n') ?? ''
			expect(requestText).toContain('second.txt')
			expect(requestText).not.toContain('first.txt')
		} finally {
			await harness.shutdown()
			await rm(basePath, { recursive: true, force: true })
		}
	})

	it('recovers markUsed metadata when the consumption event append failed', async () => {
		class FailOnceConsumptionEventStore extends MemoryEventStore {
			failNextConsumption = false

			protected override async doAppend(sessionId: SessionId, event: DomainEvent): Promise<void> {
				if (this.failNextConsumption && event.type === 'attachments_consumed') {
					this.failNextConsumption = false
					throw new Error('Injected consumption append failure')
				}
				await super.doAppend(sessionId, event)
			}
		}

		const basePath = `/tmp/roj-upload-mark-used-recovery-${crypto.randomUUID()}`
		const platform = createNodePlatform()
		const dataFileStore = new SessionFileStore(basePath, undefined, false, platform.fs, 'session')
		const eventStore = new FailOnceConsumptionEventStore()
		const preset = createTestPreset({ plugins: [uploadsPlugin.configure({ dataFileStore })] })
		const source = new TestHarness({ presets: [preset], eventStore })
		let recovered: TestHarness | undefined
		let reopened: TestHarness | undefined

		try {
			const session = await source.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Prepare markUsed recovery')
			const upload = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'used-before-event.txt',
					mimeType: 'text/plain',
					size: 17,
					fileBuffer: Buffer.from('used-before-event'),
				}),
				syncUploadSchema,
			)

			eventStore.failNextConsumption = true
			const marked = await session.callPluginMethod('uploads.markUsed', {
				sessionId: String(session.sessionId),
				uploadIds: [upload.uploadId],
				messageId: 'durable-used-message',
			})
			expect(marked.ok).toBe(false)
			expect(session.getPluginState<UploadsState>('uploads')?.pending).toHaveLength(1)
			await source.shutdown()

			recovered = new TestHarness({ presets: [preset], eventStore })
			const recoveredSession = await recovered.openSession(session.sessionId)
			expect(recoveredSession.getPluginState<UploadsState>('uploads')?.pending).toHaveLength(0)
			const consumptionEvents = await recoveredSession.getEventsByType(uploadEvents, 'attachments_consumed')
			expect(consumptionEvents.filter((event) => event.uploadIds.some((uploadId) => String(uploadId) === upload.uploadId))).toHaveLength(1)
			await recoveredSession.resumeAgent(entryAgentId)
			await recoveredSession.waitForIdle()
			expect(recovered.llmProvider.getCallCount()).toBe(0)
			await recovered.shutdown()
			recovered = undefined

			reopened = new TestHarness({ presets: [preset], eventStore })
			const reopenedSession = await reopened.openSession(session.sessionId)
			expect(reopenedSession.getPluginState<UploadsState>('uploads')?.pending).toHaveLength(0)
			const reopenedConsumption = await reopenedSession.getEventsByType(uploadEvents, 'attachments_consumed')
			expect(reopenedConsumption.filter((event) => event.uploadIds.some((uploadId) => String(uploadId) === upload.uploadId))).toHaveLength(1)
		} finally {
			await source.shutdown()
			await recovered?.shutdown()
			await reopened?.shutdown()
			await rm(basePath, { recursive: true, force: true })
		}
	})

	it('reconciles projection and metadata in both directions without duplicate terminal events', async () => {
		class CountingEventStore extends MemoryEventStore {
			loadCount = 0

			override async load(sessionId: Parameters<MemoryEventStore['load']>[0]) {
				this.loadCount++
				return super.load(sessionId)
			}
		}

		const basePath = `/tmp/roj-upload-recovery-${crypto.randomUUID()}`
		const platform = createNodePlatform()
		const dataFileStore = new SelectiveFailureStore(
			new SessionFileStore(basePath, undefined, false, platform.fs, 'session'),
		)
		const eventStore = new CountingEventStore()
		const preset = createTestPreset({
			plugins: [uploadsPlugin.configure({ dataFileStore })],
		})
		const source = new TestHarness({ presets: [preset], eventStore })
		let recovered: TestHarness | undefined
		let reopened: TestHarness | undefined

		try {
			const session = await source.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Keep upload pending')
			const upload = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'recovery.txt',
					mimeType: 'text/plain',
					size: 8,
					fileBuffer: Buffer.from('recovery'),
				}),
				syncUploadSchema,
			)
			const unreadable = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'unreadable.txt',
					mimeType: 'text/plain',
					size: 10,
					fileBuffer: Buffer.from('unreadable'),
				}),
				syncUploadSchema,
			)
			dataFileStore.failRead(`sessions/${session.sessionId}/uploads/${unreadable.uploadId}/meta.json`)
			const uploadStore = dataFileStore.scoped(`sessions/${session.sessionId}/uploads/${upload.uploadId}`)
			const metadataWrite = await uploadStore.write('meta.json', JSON.stringify({
				uploadId: UploadId(upload.uploadId),
				sessionId: session.sessionId,
				filename: 'recovery.txt',
				mimeType: 'text/plain',
				size: 8,
				path: `${basePath}/sessions/${session.sessionId}/uploads/${upload.uploadId}/recovery.txt`,
				status: 'processing',
				createdAt: Date.now(),
			}))
			expect(metadataWrite.ok).toBe(true)
			const missingEventUploadId = generateUploadId()
			const missingEventStore = dataFileStore.scoped(`sessions/${session.sessionId}/uploads/${missingEventUploadId}`)
			const missingEventMetadata = await missingEventStore.write('meta.json', JSON.stringify({
				uploadId: missingEventUploadId,
				sessionId: session.sessionId,
				filename: 'metadata-ahead.txt',
				mimeType: 'text/plain',
				size: 14,
				path: `${basePath}/sessions/${session.sessionId}/uploads/${missingEventUploadId}/metadata-ahead.txt`,
				status: 'ready',
				extractedContent: 'metadata ahead',
				createdAt: Date.now(),
				completedAt: Date.now(),
			}))
			expect(missingEventMetadata.ok).toBe(true)
			await source.shutdown()

			eventStore.loadCount = 0
			recovered = new TestHarness({ presets: [preset], eventStore })
			const recoveredSession = await recovered.openSession(session.sessionId)
			expect(eventStore.loadCount).toBe(1)
			expect(recoveredSession.getPluginState<UploadsState>('uploads')?.pending).toHaveLength(3)
			const terminalEvents = await recoveredSession.getEventsByType(uploadEvents, 'attachment_uploaded')
			expect(terminalEvents.filter((event) => String(event.uploadId) === upload.uploadId && event.status !== 'processing')).toHaveLength(1)
			expect(terminalEvents.filter((event) => String(event.uploadId) === String(missingEventUploadId) && event.status !== 'processing')).toHaveLength(1)
			const recoveredDeletions = await recoveredSession.getEventsByType(uploadEvents, 'attachment_deletion_completed')
			expect(recoveredDeletions.filter((event) => String(event.uploadId) === unreadable.uploadId)).toHaveLength(0)
			expect(recoveredSession.getPluginState<UploadsState>('uploads')?.terminal[unreadable.uploadId]).toBe('ready')
			await recovered.shutdown()
			recovered = undefined

			eventStore.loadCount = 0
			reopened = new TestHarness({ presets: [preset], eventStore })
			const reopenedSession = await reopened.openSession(session.sessionId)
			expect(eventStore.loadCount).toBe(1)
			const reopenedEvents = await reopenedSession.getEventsByType(uploadEvents, 'attachment_uploaded')
			expect(reopenedEvents.filter((event) => String(event.uploadId) === upload.uploadId && event.status !== 'processing')).toHaveLength(1)
			expect(reopenedEvents.filter((event) => String(event.uploadId) === String(missingEventUploadId) && event.status !== 'processing')).toHaveLength(1)
			const reopenedDeletions = await reopenedSession.getEventsByType(uploadEvents, 'attachment_deletion_completed')
			expect(reopenedDeletions.filter((event) => String(event.uploadId) === unreadable.uploadId)).toHaveLength(0)
		} finally {
			await source.shutdown()
			await recovered?.shutdown()
			await reopened?.shutdown()
			await rm(basePath, { recursive: true, force: true })
		}
	})
	it('settles the upload lifecycle when writing the file throws', async () => {
		const basePath = `/tmp/roj-upload-write-throw-${crypto.randomUUID()}`
		const platform = createNodePlatform()
		const dataFileStore = new SelectiveFailureStore(new SessionFileStore(basePath, undefined, false, platform.fs, 'session'))
		dataFileStore.throwOnWrite('boom.txt')
		// A short drain bound keeps a regression inside the 1s deadline below instead of the 30s default.
		const harness = new TestHarness({
			presets: [createTestPreset({ plugins: [uploadsPlugin.configure({ dataFileStore, closeDrainTimeoutMs: 200 })] })],
		})

		try {
			const session = await harness.createSession('test')
			const result = await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: 'boom.txt',
				mimeType: 'text/plain',
				size: 4,
				fileBuffer: Buffer.from('boom'),
			})
			expect(result.ok).toBe(false)

			// The lifecycle is registered before the write, so a throw leaves an orphan
			// whose completion onSessionClose then awaits forever.
			const outcome = await raceDeadline(harness.shutdown().then(() => 'closed' as const), 1_000)
			expect(outcome).toBe('closed')
		} finally {
			await harness.shutdown()
			await rm(basePath, { recursive: true, force: true })
		}
	})

	it('bounds the close wait when an upload mutation never settles', async () => {
		const deletionStarted = deferred()
		const releaseDeletion = deferred()
		class WedgedDeletionEventStore extends MemoryEventStore {
			protected override async doAppend(sessionId: SessionId, event: DomainEvent): Promise<void> {
				if (event.type === 'attachment_deletion_completed') {
					deletionStarted.resolve()
					await releaseDeletion.promise
				}
				await super.doAppend(sessionId, event)
			}
		}

		const harness = new TestHarness({
			presets: [createPreset({ closeDrainTimeoutMs: 20 })],
			eventStore: new WedgedDeletionEventStore(),
		})
		let deletion: Promise<unknown> | undefined

		try {
			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Keep upload pending')
			const upload = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'wedged.txt',
					mimeType: 'text/plain',
					size: 6,
					fileBuffer: Buffer.from('wedged'),
				}),
				syncUploadSchema,
			)
			deletion = session.callPluginMethod('uploads.delete', {
				sessionId: String(session.sessionId),
				uploadId: upload.uploadId,
			})
			await deletionStarted.promise

			const outcome = await raceDeadline(harness.shutdown().then(() => 'closed' as const), 2_000)
			expect(outcome).toBe('closed')
		} finally {
			releaseDeletion.resolve()
			await deletion
			await harness.shutdown()
		}
	})

	it('notifies and stays recoverable when every terminal event append fails', async () => {
		const eventStore = new FailTerminalEventStore()

		const basePath = `/tmp/roj-upload-terminal-append-${crypto.randomUUID()}`
		const platform = createNodePlatform()
		const dataFileStore = new SessionFileStore(basePath, undefined, false, platform.fs, 'session')
		const preset = createTestPreset({ plugins: [uploadsPlugin.configure({ dataFileStore })] })
		const source = new TestHarness({ presets: [preset], eventStore })
		let recovered: TestHarness | undefined

		try {
			const session = await source.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Keep upload pending')
			// Every attempt fails, so the plugin exhausts its retries and the append is genuinely lost.
			eventStore.terminalFailuresLeft = Number.POSITIVE_INFINITY
			const upload = okValue(
				await session.callPluginMethod('uploads.uploadAsync', {
					sessionId: String(session.sessionId),
					filename: 'append-fails.txt',
					mimeType: 'text/plain',
					size: 12,
					fileBuffer: Buffer.from('append-fails'),
				}),
				asyncUploadSchema,
			)

			// The client flips out of 'processing' on this notification only — it has no polling fallback.
			await waitForTerminal(source, upload.uploadId, 'ready', { timeoutMs: 2_000 })
			await waitUntil(() => uploadLeaseCount(source, upload.uploadId) === 0)

			const metaResult = await dataFileStore.read(`sessions/${session.sessionId}/uploads/${upload.uploadId}/meta.json`)
			expect(metaResult.ok).toBe(true)
			if (!metaResult.ok) throw new Error('Expected upload metadata')
			const metadata = terminalMetadataSchema.parse(JSON.parse(metaResult.value))
			expect(metadata.status).toBe('ready')
			expect(metadata.terminalEventPersisted).not.toBe(true)
			const sourceTerminalEvents = await session.getEventsByType(uploadEvents, 'attachment_uploaded')
			expect(sourceTerminalEvents.filter((event) => String(event.uploadId) === upload.uploadId && event.status === 'ready')).toHaveLength(0)
			await source.shutdown()

			eventStore.terminalFailuresLeft = 0
			recovered = new TestHarness({ presets: [preset], eventStore })
			const recoveredSession = await recovered.openSession(session.sessionId)
			const recoveredEvents = await recoveredSession.getEventsByType(uploadEvents, 'attachment_uploaded')
			expect(recoveredEvents.filter((event) => String(event.uploadId) === upload.uploadId && event.status === 'ready')).toHaveLength(1)
			const pendingIds = recoveredSession.getPluginState<UploadsState>('uploads')?.pending.map((pending) => String(pending.uploadId))
			expect(pendingIds).toEqual([upload.uploadId])
		} finally {
			await source.shutdown()
			await recovered?.shutdown()
			await rm(basePath, { recursive: true, force: true })
		}
	})

	it('keeps uploads inherited from a fork once the fork has an upload of its own', async () => {
		const basePath = `/tmp/roj-upload-fork-${crypto.randomUUID()}`
		const platform = createNodePlatform()
		const dataFileStore = new SessionFileStore(basePath, undefined, false, platform.fs, 'session')
		const eventStore = new MemoryEventStore()
		const preset = createTestPreset({ plugins: [uploadsPlugin.configure({ dataFileStore })] })
		const source = new TestHarness({ presets: [preset], eventStore })
		let reopened: TestHarness | undefined

		try {
			const session = await source.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Keep upload pending')
			const inherited = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'inherited.txt',
					mimeType: 'text/plain',
					size: 9,
					fileBuffer: Buffer.from('inherited'),
				}),
				syncUploadSchema,
			)

			const sourceEvents = await eventStore.load(session.sessionId)
			const forkResult = await source.sessionManager.forkSession(session.sessionId, sourceEvents.length - 1)
			expect(forkResult.ok).toBe(true)
			if (!forkResult.ok) throw new Error('Expected fork')
			// forkSession copies the event log but not the uploads dir.
			const forked = new TestSession(forkResult.value, source)
			const own = okValue(
				await forked.callPluginMethod('uploads.upload', {
					sessionId: String(forked.sessionId),
					filename: 'own.txt',
					mimeType: 'text/plain',
					size: 3,
					fileBuffer: Buffer.from('own'),
				}),
				syncUploadSchema,
			)
			await source.shutdown()

			reopened = new TestHarness({ presets: [preset], eventStore })
			const reopenedFork = await reopened.openSession(forked.sessionId)
			const deletions = await reopenedFork.getEventsByType(uploadEvents, 'attachment_deletion_completed')
			expect(deletions.filter((event) => String(event.uploadId) === inherited.uploadId)).toHaveLength(0)
			const pendingIds = reopenedFork.getPluginState<UploadsState>('uploads')?.pending.map((pending) => String(pending.uploadId))
			expect(pendingIds).toEqual([inherited.uploadId, own.uploadId])
		} finally {
			await source.shutdown()
			await reopened?.shutdown()
			await rm(basePath, { recursive: true, force: true })
		}
	})
	it('reports a store fault as an internal error without echoing the driver message', async () => {
		const basePath = `/tmp/roj-upload-store-fault-${crypto.randomUUID()}`
		const platform = createNodePlatform()
		const dataFileStore = new SelectiveFailureStore(new SessionFileStore(basePath, undefined, false, platform.fs, 'session'))
		// Stands in for a cloud object store whose SDK exception names bucket, endpoint and request id.
		const driverDetail = 'bucket=attachments-eu endpoint=objects.internal request=req-8f2c'
		dataFileStore.throwOnWrite('thrown.txt', `PutObject failed: ${driverDetail}`)
		dataFileStore.failWrite('errored.txt', `PutObject failed: ${driverDetail}`)
		const harness = new TestHarness({
			presets: [createTestPreset({ plugins: [uploadsPlugin.configure({ dataFileStore, closeDrainTimeoutMs: 200 })] })],
		})

		try {
			const session = await harness.createSession('test')
			for (const filename of ['thrown.txt', 'errored.txt']) {
				const result = await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename,
					mimeType: 'text/plain',
					size: 5,
					fileBuffer: Buffer.from('fault'),
				})
				expect(result.ok).toBe(false)
				if (result.ok) throw new Error(`Expected ${filename} to fail`)
				expect(result.error.message).toBe('Failed to write file')
				expect(result.error.message).not.toContain(driverDetail)
				// validation_error is the one type the upload route forwards to the client verbatim.
				expect(result.error.type).not.toBe('validation_error')
				expect(result.error.httpStatus).toBeGreaterThanOrEqual(500)
			}
		} finally {
			await harness.shutdown()
			await rm(basePath, { recursive: true, force: true })
		}
	})

	it('retries a transient terminal event append so the attachment still reaches the projection', async () => {
		const basePath = `/tmp/roj-upload-append-retry-${crypto.randomUUID()}`
		const platform = createNodePlatform()
		const dataFileStore = new SessionFileStore(basePath, undefined, false, platform.fs, 'session')
		const eventStore = new FailTerminalEventStore()
		const harness = new TestHarness({
			presets: [createTestPreset({ plugins: [uploadsPlugin.configure({ dataFileStore })] })],
			eventStore,
		})

		try {
			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Keep upload pending')
			// A resident runtime is only rebuilt on eviction or restart, and eviction is off by default —
			// so a dropped append leaves an attachment that is never auto-dequeued to the agent.
			eventStore.terminalFailuresLeft = 1
			const upload = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'transient.txt',
					mimeType: 'text/plain',
					size: 9,
					fileBuffer: Buffer.from('transient'),
				}),
				syncUploadSchema,
			)
			expect(upload.status).toBe('ready')

			const terminalEvents = await session.getEventsByType(uploadEvents, 'attachment_uploaded')
			expect(terminalEvents.filter((event) => String(event.uploadId) === upload.uploadId && event.status === 'ready')).toHaveLength(1)
			// The projection is what .dequeue reads, so this is the auto-dequeue precondition.
			const pendingIds = session.getPluginState<UploadsState>('uploads')?.pending.map((pending) => String(pending.uploadId))
			expect(pendingIds).toEqual([upload.uploadId])
			const metaResult = await dataFileStore.read(`sessions/${session.sessionId}/uploads/${upload.uploadId}/meta.json`)
			expect(metaResult.ok).toBe(true)
			if (!metaResult.ok) throw new Error('Expected upload metadata')
			expect(terminalMetadataSchema.parse(JSON.parse(metaResult.value)).terminalEventPersisted).toBe(true)
		} finally {
			await harness.shutdown()
			await rm(basePath, { recursive: true, force: true })
		}
	})

	it('names the wedged mutation when the close drain expires', async () => {
		const deletionStarted = deferred()
		const releaseDeletion = deferred()
		class WedgedDeletionEventStore extends MemoryEventStore {
			protected override async doAppend(sessionId: SessionId, event: DomainEvent): Promise<void> {
				if (event.type === 'attachment_deletion_completed') {
					deletionStarted.resolve()
					await releaseDeletion.promise
				}
				await super.doAppend(sessionId, event)
			}
		}

		const basePath = `/tmp/roj-upload-drain-warning-${crypto.randomUUID()}`
		const platform = createNodePlatform()
		// TestHarness pins a silent logger, so the warning is only observable through a manager we build here.
		const logger = new CapturingLogger()
		const dataFileStore = new SessionFileStore(basePath, undefined, false, platform.fs, 'session')
		const manager = new SessionManager({
			eventStore: new WedgedDeletionEventStore(),
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Mock response', toolCalls: [] }),
			toolExecutor: new ToolExecutor(logger),
			presets: new Map([['test', createPreset({ closeDrainTimeoutMs: 20 })]]),
			logger,
			basePath,
			dataFileStore,
			platform,
			systemPlugins: [uploadsPlugin],
		})
		let deletion: Promise<unknown> | undefined

		try {
			const created = await manager.createSession('test')
			expect(created.ok).toBe(true)
			if (!created.ok) throw new Error(created.error.message)
			const session = created.value
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Keep upload pending')
			const upload = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.id),
					filename: 'wedged.txt',
					mimeType: 'text/plain',
					size: 6,
					fileBuffer: Buffer.from('wedged'),
				}),
				syncUploadSchema,
			)
			deletion = session.callPluginMethod('uploads.delete', {
				sessionId: String(session.id),
				uploadId: upload.uploadId,
			})
			await deletionStarted.promise

			await manager.shutdown()

			const warning = logger.warns.find((entry) => entry.message === 'Upload lifecycles did not settle before close')
			expect(warning).toBeDefined()
			// The upload settled out of activeUploads before the delete wedged, so it names nothing on its own.
			expect(warning?.context?.pendingUploadIds).toEqual([])
			expect(warning?.context?.pendingMutations).toEqual([`upload:${upload.uploadId}:delete`])
		} finally {
			releaseDeletion.resolve()
			await deletion
			await manager.shutdown()
			await rm(basePath, { recursive: true, force: true })
		}
	})

	it('keeps the delete guard when the close drain expires with an upload still processing', async () => {
		const started = deferred()
		const abortSeen = deferred()
		const release = deferred()
		const preprocessor: Preprocessor = {
			name: 'ignores-abort',
			supportedMimeTypes: ['text/plain'],
			process: async (_filePath: string, _mimeType: string, ctx: PreprocessorContext) => {
				started.resolve()
				ctx.signal?.addEventListener('abort', () => abortSeen.resolve(), { once: true })
				await release.promise
				return Ok({ extractedContent: 'late' })
			},
		}

		const basePath = `/tmp/roj-upload-drain-clear-${crypto.randomUUID()}`
		const platform = createNodePlatform()
		const dataFileStore = new SelectiveFailureStore(new SessionFileStore(basePath, undefined, false, platform.fs, 'session'))
		const harness = new TestHarness({
			presets: [
				createTestPreset({
					plugins: [uploadsPlugin.configure({
						dataFileStore,
						preprocessorRegistry: registryWith(preprocessor),
						// The grace outlives the drain bound, so the upload is still in flight when the maps are cleared.
						processingAbortGraceMs: 400,
						closeDrainTimeoutMs: 10,
					})],
				}),
			],
		})
		let deletion: Promise<unknown> | undefined

		try {
			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Keep upload pending')
			const upload = okValue(
				await session.callPluginMethod('uploads.uploadAsync', {
					sessionId: String(session.sessionId),
					filename: 'racing.txt',
					mimeType: 'text/plain',
					size: 6,
					fileBuffer: Buffer.from('racing'),
				}),
				asyncUploadSchema,
			)
			await started.promise
			deletion = session.callPluginMethod('uploads.delete', {
				sessionId: String(session.sessionId),
				uploadId: upload.uploadId,
			})
			await abortSeen.promise

			await harness.shutdown()
			await deletion

			// Nothing may re-materialize the upload after the delete claimed it: 'processing' is the
			// pre-delete write, 'deleted' the delete's own.
			const statuses = dataFileStore
				.writtenPaths('meta.json')
				.map((write) => terminalMetadataSchema.parse(JSON.parse(write.content)).status)
			expect(statuses).toEqual(['processing', 'deleted'])
		} finally {
			release.resolve()
			await deletion
			await harness.shutdown()
			await rm(basePath, { recursive: true, force: true })
		}
	})
	it('rejects an upload filename that is not a basename, before anything is written', async () => {
		const basePath = `/tmp/roj-upload-filename-${crypto.randomUUID()}`
		const platform = createNodePlatform()
		const dataFileStore = new SessionFileStore(basePath, undefined, false, platform.fs, 'session')
		const harness = new TestHarness({
			presets: [createTestPreset({ plugins: [uploadsPlugin.configure({ dataFileStore, closeDrainTimeoutMs: 200 })] })],
		})

		try {
			const session = await harness.createSession('test')
			// prepareUpload is reachable from callers that never pass the HTTP boundary check.
			for (const filename of ['nested/inner.txt', '../escaped.txt', 'back\\slash.txt', '', '.', '..', 'nul\0.txt']) {
				const result = await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename,
					mimeType: 'text/plain',
					size: 4,
					fileBuffer: Buffer.from('walk'),
				})
				expect(result.ok).toBe(false)
				if (result.ok) throw new Error(`Expected ${JSON.stringify(filename)} to be rejected`)
				expect(result.error.message).toBe('Invalid filename')
				expect(result.error.type).toBe('validation_error')
			}

			// A rejected name must not have created an upload directory, let alone a subtree under it.
			const listed = await dataFileStore.list(`sessions/${session.sessionId}/uploads`, { maxDepth: 3 })
			expect(listed.ok ? listed.value : []).toEqual([])
		} finally {
			await harness.shutdown()
			await rm(basePath, { recursive: true, force: true })
		}
	})

	it('rejects an upload id that walks out of its own session directory', async () => {
		const basePath = `/tmp/roj-upload-id-traversal-${crypto.randomUUID()}`
		const platform = createNodePlatform()
		const dataFileStore = new SessionFileStore(basePath, undefined, false, platform.fs, 'session')
		const harness = new TestHarness({
			presets: [createTestPreset({ plugins: [uploadsPlugin.configure({ dataFileStore, closeDrainTimeoutMs: 200 })] })],
		})

		try {
			const victim = await harness.createSession('test')
			const attacker = await harness.createSession('test')
			const victimEntryAgentId = victim.getEntryAgentId()
			if (!victimEntryAgentId) throw new Error('Expected entry agent')
			await victim.pauseAgent(victimEntryAgentId, 'Keep upload pending')
			const upload = okValue(
				await victim.callPluginMethod('uploads.upload', {
					sessionId: String(victim.sessionId),
					filename: 'victim.txt',
					mimeType: 'text/plain',
					size: 6,
					fileBuffer: Buffer.from('victim'),
				}),
				syncUploadSchema,
			)

			// markUsed never compares meta.sessionId, so the id is the only thing keeping the write in-session.
			const traversingId = `../../${victim.sessionId}/uploads/${upload.uploadId}`
			const marked = await attacker.callPluginMethod('uploads.markUsed', {
				sessionId: String(attacker.sessionId),
				uploadIds: [traversingId],
				messageId: 'attacker-message',
			})
			expect(marked.ok).toBe(false)

			const metaResult = await dataFileStore.read(`sessions/${victim.sessionId}/uploads/${upload.uploadId}/meta.json`)
			expect(metaResult.ok).toBe(true)
			if (!metaResult.ok) throw new Error('Expected the victim upload metadata')
			expect(usedMetadataSchema.parse(JSON.parse(metaResult.value)).usedInMessageId).toBeUndefined()

			for (const method of ['uploads.delete', 'uploads.loadAttachments']) {
				const input = method === 'uploads.delete'
					? { sessionId: String(attacker.sessionId), uploadId: traversingId }
					: { sessionId: String(attacker.sessionId), uploadIds: [traversingId] }
				const result = await attacker.callPluginMethod(method, input)
				expect(result.ok).toBe(false)
				if (result.ok) throw new Error(`Expected ${method} to reject a traversing upload id`)
				expect(result.error.type).toBe('validation_error')
			}
		} finally {
			await harness.shutdown()
			await rm(basePath, { recursive: true, force: true })
		}
	})
})
