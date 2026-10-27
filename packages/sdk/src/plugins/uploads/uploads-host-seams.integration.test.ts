/**
 * Host seams of the uploads plugin: host-supplied preprocessors, uploads whose bytes
 * the host stored itself (registerStored), and releasing those bytes on delete.
 */
import { describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { MemoryEventStore } from '~/core/events/memory.js'
import z from 'zod/v4'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { silentLogger } from '~/lib/logger/logger.js'
import { Err, Ok, type Result } from '~/lib/utils/result.js'
import { createTestPreset, TestHarness, type TestSession } from '~/testing/index.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { type UploadsPluginConfig, uploadsPlugin } from './plugin.js'
import { type Preprocessor, type PreprocessorContext, PreprocessorRegistry, type PreprocessorResult } from './preprocessor.js'
import { ImageClassifierPreprocessor } from './preprocessors/image-classifier.js'
import { generateUploadId } from './schema.js'
import type { UploadBlobContext, UploadBlobStore, UploadSource } from './source.js'
import type { UploadsState } from './state.js'

const processingSchema = z.object({ uploadId: z.string(), status: z.literal('processing') })
const syncUploadSchema = z.object({ uploadId: z.string(), status: z.literal('ready') })
const statusChangedSchema = z.object({ uploadId: z.string(), status: z.enum(['processing', 'ready', 'failed']) })

const metadataSchema = z.object({
	status: z.enum(['processing', 'ready', 'failed', 'deleted']),
	path: z.string(),
	source: z.unknown().optional(),
	artifacts: z.unknown().optional(),
	capabilities: z.unknown().optional(),
	attempts: z.number().optional(),
})

const SHA256 = 'a'.repeat(64)

function okValue<T>(result: { ok: boolean; value?: unknown }, schema: z.ZodType<T>): T {
	expect(result.ok).toBe(true)
	if (!result.ok) throw new Error('Expected ok result')
	return schema.parse(result.value)
}

function bytesSource(bytes: Uint8Array, sha256?: string): UploadSource {
	return {
		size: bytes.length,
		sha256,
		stream: () => new Blob([bytes]).stream(),
		bytes: async () => bytes,
		range: async (offset, length) => bytes.subarray(offset, offset + length),
	}
}

class MemoryBlobStore implements UploadBlobStore {
	readonly blobs = new Map<string, Uint8Array>()
	readonly opened: string[] = []
	readonly openedWith: UploadBlobContext[] = []
	readonly released: string[][] = []
	readonly releasedWith: UploadBlobContext[] = []
	failRelease = false

	async open(blobRef: string, ctx: UploadBlobContext): Promise<Result<UploadSource, Error>> {
		this.opened.push(blobRef)
		this.openedWith.push(ctx)
		const bytes = this.blobs.get(blobRef)
		return bytes ? Ok(bytesSource(bytes, SHA256)) : Err(new Error(`No blob: ${blobRef}`))
	}

	async release(blobRefs: readonly string[], ctx: UploadBlobContext): Promise<void> {
		this.released.push([...blobRefs])
		this.releasedWith.push(ctx)
		if (this.failRelease) throw new Error('Injected release failure')
	}
}

interface RecordedRun {
	localPath?: string
	bytes: Uint8Array
	ctx: PreprocessorContext
}

const HOST_RESULT: PreprocessorResult = {
	extractedContent: 'Quarterly report text',
	artifacts: [{ path: 'preview-1.jpg', mimeType: 'image/jpeg', size: 4, blobRef: 'blob-preview-1', description: 'Page 1' }],
	capabilities: { text: true, embeddedImages: false, pagesProcessed: 2 },
}

/** A host preprocessor that reads the source, writes its preview and reports artifacts and capabilities. */
function hostPreprocessor(runs: RecordedRun[]): Preprocessor {
	return {
		name: 'host-pdf',
		supportedMimeTypes: ['application/pdf'],
		async process(source, _mimeType, ctx) {
			runs.push({ localPath: source.localPath, bytes: await source.bytes(), ctx })
			const preview = await ctx.files.write('preview-1.jpg', Buffer.from('jpeg'))
			if (!preview.ok) return Err(new Error(preview.error))
			return Ok(HOST_RESULT)
		},
	}
}

function registryWith(preprocessor: Preprocessor): PreprocessorRegistry {
	const registry = new PreprocessorRegistry()
	registry.register(preprocessor)
	return registry
}

function createFixture(config: Omit<UploadsPluginConfig, 'dataFileStore'>) {
	const basePath = `/tmp/roj-upload-host-${crypto.randomUUID()}`
	const dataFileStore = new SessionFileStore(basePath, undefined, false, createNodePlatform().fs, 'session')
	const eventStore = new MemoryEventStore()
	const preset = createTestPreset({ plugins: [uploadsPlugin.configure({ dataFileStore, ...config })] })
	const harnesses: TestHarness[] = []
	const open = (): TestHarness => {
		const harness = new TestHarness({
			presets: [preset],
			eventStore,
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
		})
		harnesses.push(harness)
		return harness
	}
	return {
		harness: open(),
		/** Another runtime over the same log and files, as after a restart. */
		reopen: open,
		dataFileStore,
		async cleanup() {
			for (const harness of harnesses) await harness.shutdown()
			await rm(basePath, { recursive: true, force: true })
		},
	}
}

async function pauseEntryAgent(session: TestSession): Promise<void> {
	const entryAgentId = session.getEntryAgentId()
	if (!entryAgentId) throw new Error('Expected entry agent')
	await session.pauseAgent(entryAgentId, 'Keep upload pending')
}

async function waitForStatus(harness: TestHarness, uploadId: string, status: 'ready' | 'failed'): Promise<void> {
	await harness.notifications.waitFor((notification) => {
		if (notification.pluginName !== 'uploads' || notification.type !== 'uploadStatusChanged') return false
		const parsed = statusChangedSchema.safeParse(notification.payload)
		return parsed.success && parsed.data.uploadId === uploadId && parsed.data.status === status
	})
}

async function readMetadata(dataFileStore: SessionFileStore, session: TestSession, uploadId: string) {
	const meta = await dataFileStore.read(`sessions/${session.sessionId}/uploads/${uploadId}/meta.json`)
	if (!meta.ok) throw new Error(meta.error)
	return metadataSchema.parse(JSON.parse(meta.value))
}

describe('uploads host preprocessors', () => {
	it('hands the preprocessor a source and carries its artifacts and capabilities into metadata and the agent message', async () => {
		const runs: RecordedRun[] = []
		const fixture = createFixture({ preprocessorRegistry: registryWith(hostPreprocessor(runs)) })
		try {
			const session = await fixture.harness.createSession('test')
			const fileBuffer = Buffer.from('%PDF')
			const upload = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'report.pdf',
					mimeType: 'application/pdf',
					size: fileBuffer.length,
					fileBuffer,
				}),
				syncUploadSchema,
			)

			expect(runs).toHaveLength(1)
			expect(runs[0]?.localPath?.endsWith(`/uploads/${upload.uploadId}/report.pdf`)).toBe(true)
			expect(Buffer.from(runs[0]?.bytes ?? new Uint8Array()).toString()).toBe('%PDF')
			expect(runs[0]?.ctx).toMatchObject({
				uploadId: upload.uploadId,
				sessionId: String(session.sessionId),
				filename: 'report.pdf',
				attempt: 1,
			})

			expect(await readMetadata(fixture.dataFileStore, session, upload.uploadId)).toMatchObject({
				status: 'ready',
				source: { kind: 'file' },
				artifacts: HOST_RESULT.artifacts,
				capabilities: HOST_RESULT.capabilities,
				attempts: 1,
			})

			await session.waitForIdle()
			const request = fixture.harness.llmProvider.getLastRequest()
			const attachment = request?.messages.find((m) => typeof m.content === 'string' && m.content.includes('<attachment'))
			if (!attachment || typeof attachment.content !== 'string') throw new Error('Expected the attachment message')
			expect(attachment.content).toContain(
				`/uploads/${upload.uploadId}" capabilities="text,embeddedImages=false,pagesProcessed=2">\n`
					+ 'Quarterly report text\n'
					+ '- preview-1.jpg (image/jpeg, 4B) — Page 1 (original kept by host)\n'
					+ '</attachment>',
			)
		} finally {
			await fixture.cleanup()
		}
	})
})

describe('uploads.registerStored', () => {
	it('processes bytes from the blob store without writing the original into the upload dir', async () => {
		const runs: RecordedRun[] = []
		const blobStore = new MemoryBlobStore()
		blobStore.blobs.set('blob-original', new Uint8Array([1, 2, 3]))
		const fixture = createFixture({ preprocessorRegistry: registryWith(hostPreprocessor(runs)), blobStore })
		try {
			const session = await fixture.harness.createSession('test')
			await pauseEntryAgent(session)

			const upload = okValue(
				await session.callPluginMethod('uploads.registerStored', {
					sessionId: String(session.sessionId),
					filename: 'scan.pdf',
					mimeType: 'application/pdf',
					size: 3,
					sha256: SHA256,
					blobRef: 'blob-original',
				}),
				processingSchema,
			)
			await waitForStatus(fixture.harness, upload.uploadId, 'ready')

			expect(blobStore.opened).toEqual(['blob-original'])
			expect(runs).toHaveLength(1)
			expect(runs[0]?.localPath).toBeUndefined()
			expect([...(runs[0]?.bytes ?? [])]).toEqual([1, 2, 3])
			expect(runs[0]?.ctx).toMatchObject({ uploadId: upload.uploadId, filename: 'scan.pdf', attempt: 1 })

			const listed = await fixture.dataFileStore.list(`sessions/${session.sessionId}/uploads/${upload.uploadId}`)
			if (!listed.ok) throw new Error(listed.error)
			expect(listed.value.map((entry) => entry.name).sort()).toEqual(['meta.json', 'preview-1.jpg'])
			expect(await readMetadata(fixture.dataFileStore, session, upload.uploadId)).toMatchObject({
				status: 'ready',
				source: { kind: 'blob', blobRef: 'blob-original', sha256: SHA256 },
				artifacts: HOST_RESULT.artifacts,
				attempts: 1,
			})
			const pending = session.getPluginState<UploadsState>('uploads')?.pending
			expect(pending?.map((entry) => entry.capabilities)).toEqual([HOST_RESULT.capabilities])
		} finally {
			await fixture.cleanup()
		}
	})

	it('refuses a stored upload when no blob store is configured', async () => {
		const fixture = createFixture({})
		try {
			const session = await fixture.harness.createSession('test')

			const result = await session.callPluginMethod('uploads.registerStored', {
				sessionId: String(session.sessionId),
				filename: 'scan.pdf',
				mimeType: 'application/pdf',
				size: 3,
				blobRef: 'blob-original',
			})

			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.error.message).toContain('no blob store is configured')
			// The host is misconfigured, not the request refused: a caller must not drop the bytes it stored.
			expect(result.error).toMatchObject({ type: 'stored_uploads_unsupported', httpStatus: 500 })
			expect(fixture.harness.notifications.getByType('uploads', 'uploadStatusChanged')).toEqual([])
		} finally {
			await fixture.cleanup()
		}
	})

	it('answers a closing session as retryable, never as a refused request', async () => {
		const blobStore = new MemoryBlobStore()
		blobStore.blobs.set('blob-first', new Uint8Array([1, 2, 3]))
		let markStarted = () => {}
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let markAborted = () => {}
		const aborted = new Promise<void>((resolve) => {
			markAborted = resolve
		})
		let finish = () => {}
		const finished = new Promise<void>((resolve) => {
			finish = resolve
		})
		// Holds the close drain open, so the session stays in its closing window while the second call arrives.
		const holdsClose: Preprocessor = {
			name: 'holds-close',
			supportedMimeTypes: ['application/pdf'],
			async process(_source, _mimeType, ctx) {
				markStarted()
				const signal = ctx.signal
				if (!signal) throw new Error('Expected preprocessing signal')
				await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
				markAborted()
				await finished
				return Err(new Error('Processing cancelled'))
			},
		}
		const fixture = createFixture({ preprocessorRegistry: registryWith(holdsClose), blobStore, processingAbortGraceMs: 10_000 })
		try {
			const session = await fixture.harness.createSession('test')
			await pauseEntryAgent(session)
			okValue(
				await session.callPluginMethod('uploads.registerStored', {
					sessionId: String(session.sessionId),
					filename: 'first.pdf',
					mimeType: 'application/pdf',
					size: 3,
					blobRef: 'blob-first',
				}),
				processingSchema,
			)
			await started
			const closed = session.close()
			await aborted

			const result = await session.callPluginMethod('uploads.registerStored', {
				sessionId: String(session.sessionId),
				filename: 'scan.pdf',
				mimeType: 'application/pdf',
				size: 3,
				blobRef: 'blob-original',
			})
			finish()
			await closed

			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.error).toEqual({ type: 'session_closing', message: 'Session is closing', httpStatus: 503 })
			expect(blobStore.opened).toEqual(['blob-first'])
		} finally {
			finish()
			await fixture.cleanup()
		}
	})

	it.each([
		['a filename that is not a basename', { filename: '../scan.pdf', size: 3 }, 'Invalid filename'],
		['a MIME type outside the allow-list', { mimeType: 'application/x-msdownload', size: 3 }, 'Unsupported file type'],
		['a size over maxFileSize', { size: 2048 }, 'File too large'],
	])('rejects %s before registering anything', async (_label, override, message) => {
		const blobStore = new MemoryBlobStore()
		const fixture = createFixture({ blobStore, maxFileSize: 1024 })
		try {
			const session = await fixture.harness.createSession('test')

			const result = await session.callPluginMethod('uploads.registerStored', {
				sessionId: String(session.sessionId),
				filename: 'scan.pdf',
				mimeType: 'application/pdf',
				blobRef: 'blob-original',
				...override,
			})

			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.error.message).toContain(message)
			expect(blobStore.opened).toEqual([])
			expect((await fixture.dataFileStore.list(`sessions/${session.sessionId}/uploads`)).ok).toBe(false)
		} finally {
			await fixture.cleanup()
		}
	})
})

describe('uploads.delete with a blob store', () => {
	async function registerReady(fixture: ReturnType<typeof createFixture>, session: TestSession): Promise<string> {
		const upload = okValue(
			await session.callPluginMethod('uploads.registerStored', {
				sessionId: String(session.sessionId),
				filename: 'scan.pdf',
				mimeType: 'application/pdf',
				size: 3,
				blobRef: 'blob-original',
			}),
			processingSchema,
		)
		await waitForStatus(fixture.harness, upload.uploadId, 'ready')
		return upload.uploadId
	}

	it('releases the original and every artifact blob once the deletion completed', async () => {
		const blobStore = new MemoryBlobStore()
		blobStore.blobs.set('blob-original', new Uint8Array([1, 2, 3]))
		const fixture = createFixture({ preprocessorRegistry: registryWith(hostPreprocessor([])), blobStore })
		try {
			const session = await fixture.harness.createSession('test')
			await pauseEntryAgent(session)
			const uploadId = await registerReady(fixture, session)

			const deleted = await session.callPluginMethod('uploads.delete', { sessionId: String(session.sessionId), uploadId })

			expect(deleted.ok).toBe(true)
			expect(blobStore.released).toEqual([['blob-original', 'blob-preview-1']])
			expect(await readMetadata(fixture.dataFileStore, session, uploadId)).toMatchObject({ status: 'deleted' })
		} finally {
			await fixture.cleanup()
		}
	})

	it('completes the delete when releasing the blobs fails', async () => {
		const blobStore = new MemoryBlobStore()
		blobStore.blobs.set('blob-original', new Uint8Array([1, 2, 3]))
		blobStore.failRelease = true
		const fixture = createFixture({ preprocessorRegistry: registryWith(hostPreprocessor([])), blobStore })
		try {
			const session = await fixture.harness.createSession('test')
			await pauseEntryAgent(session)
			const uploadId = await registerReady(fixture, session)

			const deleted = await session.callPluginMethod('uploads.delete', { sessionId: String(session.sessionId), uploadId })

			expect(deleted.ok).toBe(true)
			expect(blobStore.released).toHaveLength(1)
			expect(session.getPluginState<UploadsState>('uploads')?.terminal[uploadId]).toBeUndefined()
		} finally {
			await fixture.cleanup()
		}
	})
})

describe('stored upload paths', () => {
	const attachmentsSchema = z.object({ attachments: z.array(z.object({ path: z.string() })) })

	async function registerReady(fixture: ReturnType<typeof createFixture>, session: TestSession, mimeType: string): Promise<string> {
		const upload = okValue(
			await session.callPluginMethod('uploads.registerStored', {
				sessionId: String(session.sessionId),
				filename: 'scan.pdf',
				mimeType,
				size: 3,
				blobRef: 'blob-original',
			}),
			processingSchema,
		)
		await waitForStatus(fixture.harness, upload.uploadId, 'ready')
		return upload.uploadId
	}

	it.each([
		['its first artifact', 'application/pdf', '/preview-1.jpg'],
		['the upload dir when it has no artifacts', 'text/plain', ''],
	])('point a stored upload at %s, never at an original that is not there', async (_label, mimeType, suffix) => {
		const blobStore = new MemoryBlobStore()
		blobStore.blobs.set('blob-original', new Uint8Array([1, 2, 3]))
		const fixture = createFixture({ preprocessorRegistry: registryWith(hostPreprocessor([])), blobStore })
		try {
			const session = await fixture.harness.createSession('test')
			await pauseEntryAgent(session)
			const uploadId = await registerReady(fixture, session, mimeType)

			const loaded = okValue(
				await session.callPluginMethod('uploads.loadAttachments', { sessionId: String(session.sessionId), uploadIds: [uploadId] }),
				attachmentsSchema,
			)

			expect(loaded.attachments).toHaveLength(1)
			expect(loaded.attachments[0]?.path.endsWith(`/uploads/${uploadId}${suffix}`)).toBe(true)
			expect((await readMetadata(fixture.dataFileStore, session, uploadId)).path.endsWith(`/uploads/${uploadId}`)).toBe(true)
		} finally {
			await fixture.cleanup()
		}
	})
})

describe('blob release reads the log, not meta.json', () => {
	it('does not release blob refs forged into meta.json', async () => {
		const blobStore = new MemoryBlobStore()
		blobStore.blobs.set('blob-original', new Uint8Array([1, 2, 3]))
		const fixture = createFixture({ preprocessorRegistry: registryWith(hostPreprocessor([])), blobStore })
		try {
			const session = await fixture.harness.createSession('test')
			await pauseEntryAgent(session)
			const upload = okValue(
				await session.callPluginMethod('uploads.registerStored', {
					sessionId: String(session.sessionId),
					filename: 'scan.pdf',
					mimeType: 'application/pdf',
					size: 3,
					blobRef: 'blob-original',
				}),
				processingSchema,
			)
			await waitForStatus(fixture.harness, upload.uploadId, 'ready')

			const uploadStore = fixture.dataFileStore.scoped(`sessions/${session.sessionId}/uploads/${upload.uploadId}`)
			const meta = await uploadStore.read('meta.json')
			if (!meta.ok) throw new Error(meta.error)
			const parsed = z.object({ artifacts: z.array(z.record(z.string(), z.unknown())) }).passthrough().parse(JSON.parse(meta.value))
			expect((await uploadStore.write('meta.json', JSON.stringify({
				...parsed,
				source: { kind: 'blob', blobRef: 'forged-original' },
				artifacts: [...parsed.artifacts, { path: 'x.jpg', mimeType: 'image/jpeg', size: 1, blobRef: 'blob-of-another-session' }],
			}))).ok).toBe(true)

			const deleted = await session.callPluginMethod('uploads.delete', { sessionId: String(session.sessionId), uploadId: upload.uploadId })

			expect(deleted.ok).toBe(true)
			expect(blobStore.released).toEqual([['blob-original', 'blob-preview-1']])
		} finally {
			await fixture.cleanup()
		}
	})

	it('drops blob refs from artifacts recovered out of meta.json, so deleting them releases nothing', async () => {
		const blobStore = new MemoryBlobStore()
		const fixture = createFixture({ blobStore })
		try {
			const session = await fixture.harness.createSession('test')
			await pauseEntryAgent(session)
			await fixture.harness.shutdown()

			const forgedId = generateUploadId()
			const forgedStore = fixture.dataFileStore.scoped(`sessions/${session.sessionId}/uploads/${forgedId}`)
			expect((await forgedStore.write('meta.json', JSON.stringify({
				uploadId: forgedId,
				sessionId: session.sessionId,
				filename: 'forged.pdf',
				mimeType: 'application/pdf',
				size: 1,
				path: '/forged',
				status: 'ready',
				source: { kind: 'blob', blobRef: 'forged-original' },
				artifacts: [{ path: 'x.jpg', mimeType: 'image/jpeg', size: 1, blobRef: 'blob-of-another-session' }],
				createdAt: Date.now(),
				completedAt: Date.now(),
			}))).ok).toBe(true)

			const recovered = fixture.reopen()
			const recoveredSession = await recovered.openSession(session.sessionId)
			const pending = recoveredSession.getPluginState<UploadsState>('uploads')?.pending
			expect(pending?.find((entry) => entry.uploadId === String(forgedId))?.artifacts).toEqual([
				{ path: 'x.jpg', mimeType: 'image/jpeg', size: 1 },
			])

			const deleted = await recoveredSession.callPluginMethod('uploads.delete', {
				sessionId: String(session.sessionId),
				uploadId: String(forgedId),
			})

			expect(deleted.ok).toBe(true)
			expect(blobStore.released).toEqual([])
		} finally {
			await fixture.cleanup()
		}
	})
})

describe('blob store context and size', () => {
	it('passes the session and upload to open and release, and releases a stored original deleted while processing', async () => {
		const blobStore = new MemoryBlobStore()
		blobStore.blobs.set('blob-original', new Uint8Array([1, 2, 3]))
		let markStarted = () => {}
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const waitsForAbort: Preprocessor = {
			name: 'waits-for-abort',
			supportedMimeTypes: ['application/pdf'],
			async process(_source, _mimeType, ctx) {
				markStarted()
				const signal = ctx.signal
				if (!signal) throw new Error('Expected preprocessing signal')
				await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
				return Err(new Error('Processing cancelled'))
			},
		}
		const fixture = createFixture({ preprocessorRegistry: registryWith(waitsForAbort), blobStore })
		try {
			const session = await fixture.harness.createSession('test')
			await pauseEntryAgent(session)
			const upload = okValue(
				await session.callPluginMethod('uploads.registerStored', {
					sessionId: String(session.sessionId),
					filename: 'scan.pdf',
					mimeType: 'application/pdf',
					size: 3,
					blobRef: 'blob-original',
				}),
				processingSchema,
			)
			await started

			const deleted = await session.callPluginMethod('uploads.delete', { sessionId: String(session.sessionId), uploadId: upload.uploadId })

			expect(deleted.ok).toBe(true)
			const context = { sessionId: String(session.sessionId), uploadId: upload.uploadId }
			expect(blobStore.openedWith).toEqual([context])
			expect(blobStore.released).toEqual([['blob-original']])
			expect(blobStore.releasedWith).toEqual([context])
			const state = session.getPluginState<UploadsState>('uploads')
			expect(state?.processing[upload.uploadId]).toBeUndefined()
			expect(state?.blobRefs[upload.uploadId]).toBeUndefined()
		} finally {
			await fixture.cleanup()
		}
	})

	it('fails a stored upload whose blob is not the size that was registered', async () => {
		const runs: RecordedRun[] = []
		const blobStore = new MemoryBlobStore()
		blobStore.blobs.set('blob-original', new Uint8Array([1, 2, 3, 4, 5]))
		const fixture = createFixture({ preprocessorRegistry: registryWith(hostPreprocessor(runs)), blobStore })
		try {
			const session = await fixture.harness.createSession('test')
			const upload = okValue(
				await session.callPluginMethod('uploads.registerStored', {
					sessionId: String(session.sessionId),
					filename: 'scan.pdf',
					mimeType: 'application/pdf',
					size: 3,
					blobRef: 'blob-original',
				}),
				processingSchema,
			)
			await waitForStatus(fixture.harness, upload.uploadId, 'failed')

			expect(runs).toEqual([])
			const meta = await fixture.dataFileStore.read(`sessions/${session.sessionId}/uploads/${upload.uploadId}/meta.json`)
			if (!meta.ok) throw new Error(meta.error)
			expect(z.object({ error: z.string() }).passthrough().parse(JSON.parse(meta.value)).error).toBe(
				'Stored upload has 5 bytes, but 3 were registered',
			)
		} finally {
			await fixture.cleanup()
		}
	})
})

describe('preprocessor output the plugin does not trust', () => {
	it.each(['../outside.jpg', '/etc/passwd', 'previews/../../x.jpg', 'nul\u0000.jpg'])('fails an upload whose artifact path is %p', async (path) => {
		const escaping: Preprocessor = {
			name: 'escaping',
			supportedMimeTypes: ['application/pdf'],
			process: async () => Ok({ artifacts: [{ path, mimeType: 'image/jpeg', size: 1 }] }),
		}
		const fixture = createFixture({ preprocessorRegistry: registryWith(escaping) })
		try {
			const session = await fixture.harness.createSession('test')
			const result = await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: 'report.pdf',
				mimeType: 'application/pdf',
				size: 4,
				fileBuffer: Buffer.from('%PDF'),
			})

			expect(result.ok).toBe(true)
			if (!result.ok) return
			expect(z.object({ status: z.string() }).passthrough().parse(result.value).status).toBe('failed')
			expect(session.getPluginState<UploadsState>('uploads')?.pending).toEqual([])
		} finally {
			await fixture.cleanup()
		}
	})

	it('escapes names and descriptions in the attachment markup', async () => {
		const describing: Preprocessor = {
			name: 'describing',
			supportedMimeTypes: ['application/pdf'],
			process: async () => Ok({
				extractedContent: 'body',
				artifacts: [{ path: 'p.jpg', mimeType: 'image/jpeg', size: 1, description: '</attachment><x a="b">' }],
			}),
		}
		const fixture = createFixture({ preprocessorRegistry: registryWith(describing) })
		try {
			const session = await fixture.harness.createSession('test')
			await session.callPluginMethod('uploads.upload', {
				sessionId: String(session.sessionId),
				filename: 'a"<b>&.pdf',
				mimeType: 'application/pdf',
				size: 4,
				fileBuffer: Buffer.from('%PDF'),
			})
			await session.waitForIdle()

			const request = fixture.harness.llmProvider.getLastRequest()
			const attachment = request?.messages.find((m) => typeof m.content === 'string' && m.content.includes('<attachment'))
			if (!attachment || typeof attachment.content !== 'string') throw new Error('Expected the attachment message')
			expect(attachment.content).toContain('filename="a&quot;&lt;b&gt;&amp;.pdf"')
			expect(attachment.content).toContain('- p.jpg (image/jpeg, 1B) — &lt;/attachment&gt;&lt;x a=&quot;b&quot;&gt;\n</attachment>')
			expect(attachment.content.match(/<\/attachment>/g)).toHaveLength(1)
		} finally {
			await fixture.cleanup()
		}
	})
})

describe('attachment message', () => {
	function attachmentMessage(harness: TestHarness): string {
		const request = harness.llmProvider.getLastRequest()
		const attachment = request?.messages.find((m) => typeof m.content === 'string' && m.content.includes('<attachment'))
		if (!attachment || typeof attachment.content !== 'string') throw new Error('Expected the attachment message')
		return attachment.content
	}

	function basePathOf(message: string): string {
		const basePath = /basePath="([^"]*)"/.exec(message)?.[1]
		if (!basePath) throw new Error('Expected a basePath attribute')
		return basePath
	}

	it('renders a local upload with its original at basePath/filename', async () => {
		const fixture = createFixture({ preprocessorRegistry: registryWith(hostPreprocessor([])) })
		try {
			const session = await fixture.harness.createSession('test')
			const upload = okValue(
				await session.callPluginMethod('uploads.upload', {
					sessionId: String(session.sessionId),
					filename: 'report.pdf',
					mimeType: 'application/pdf',
					size: 4,
					fileBuffer: Buffer.from('%PDF'),
				}),
				syncUploadSchema,
			)
			await session.waitForIdle()

			const message = attachmentMessage(fixture.harness)
			const basePath = basePathOf(message)
			expect(basePath.endsWith(`/uploads/${upload.uploadId}`)).toBe(true)
			expect(message).toBe(
				`<attachment uploadId="${upload.uploadId}" filename="report.pdf" type="application/pdf" basePath="${basePath}"`
					+ ' capabilities="text,embeddedImages=false,pagesProcessed=2">\n'
					+ 'Quarterly report text\n'
					+ '- preview-1.jpg (image/jpeg, 4B) — Page 1 (original kept by host)\n'
					+ '</attachment>',
			)
		} finally {
			await fixture.cleanup()
		}
	})

	it('tells the agent a stored original is not a file, points it at the artifacts and keeps the path for host tools', async () => {
		const blobStore = new MemoryBlobStore()
		blobStore.blobs.set('blob-original', new Uint8Array([1, 2, 3]))
		const fixture = createFixture({ preprocessorRegistry: registryWith(hostPreprocessor([])), blobStore })
		try {
			const session = await fixture.harness.createSession('test')
			const upload = okValue(
				await session.callPluginMethod('uploads.registerStored', {
					sessionId: String(session.sessionId),
					filename: 'scan.pdf',
					mimeType: 'application/pdf',
					size: 3,
					blobRef: 'blob-original',
				}),
				processingSchema,
			)
			await waitForStatus(fixture.harness, upload.uploadId, 'ready')
			await session.waitForIdle()

			const message = attachmentMessage(fixture.harness)
			const basePath = basePathOf(message)
			expect(message).toBe(
				`<attachment uploadId="${upload.uploadId}" filename="scan.pdf" type="application/pdf" basePath="${basePath}"`
					+ ' capabilities="text,embeddedImages=false,pagesProcessed=2">\n'
					+ 'Quarterly report text\n'
					+ '- preview-1.jpg (image/jpeg, 4B) — Page 1 (original kept by host)\n'
					+ `The original is kept by the host and is not readable as a file: ${basePath}/scan.pdf does not exist in the session.`
					+ ' Read its content from the files listed above; their paths are relative to basePath.'
					+ ` To place or publish the original, pass ${basePath}/scan.pdf to a host tool that takes it.\n`
					+ '</attachment>',
			)
		} finally {
			await fixture.cleanup()
		}
	})

	it('lists the derived files of a stored upload that has no artifacts, such as an image description', async () => {
		const blobStore = new MemoryBlobStore()
		blobStore.blobs.set('blob-original', new Uint8Array([1, 2, 3]))
		const classifier = new ImageClassifierPreprocessor({
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'A red square.', toolCalls: [] }),
			logger: silentLogger,
			fs: createNodePlatform().fs,
		})
		const fixture = createFixture({ preprocessorRegistry: registryWith(classifier), blobStore })
		try {
			const session = await fixture.harness.createSession('test')
			const upload = okValue(
				await session.callPluginMethod('uploads.registerStored', {
					sessionId: String(session.sessionId),
					filename: 'photo.png',
					mimeType: 'image/png',
					size: 3,
					blobRef: 'blob-original',
				}),
				processingSchema,
			)
			await waitForStatus(fixture.harness, upload.uploadId, 'ready')
			await session.waitForIdle()

			const description = await fixture.dataFileStore.read(`sessions/${session.sessionId}/uploads/${upload.uploadId}/description.txt`)
			expect(description).toEqual({ ok: true, value: 'A red square.' })
			const message = attachmentMessage(fixture.harness)
			const basePath = basePathOf(message)
			expect(message).toBe(
				`<attachment uploadId="${upload.uploadId}" filename="photo.png" type="image/png" basePath="${basePath}">\n`
					+ '[Image: A red square.]\n'
					+ '- description.txt\n'
					+ `The original is kept by the host and is not readable as a file: ${basePath}/photo.png does not exist in the session.`
					+ ' Read its content from the files listed above; their paths are relative to basePath.'
					+ ` To place or publish the original, pass ${basePath}/photo.png to a host tool that takes it.\n`
					+ '</attachment>',
			)
		} finally {
			await fixture.cleanup()
		}
	})

	it('says a stored original without derived files has no file to read', async () => {
		const blobStore = new MemoryBlobStore()
		blobStore.blobs.set('blob-original', new Uint8Array([1, 2, 3]))
		const fixture = createFixture({ blobStore })
		try {
			const session = await fixture.harness.createSession('test')
			const upload = okValue(
				await session.callPluginMethod('uploads.registerStored', {
					sessionId: String(session.sessionId),
					filename: 'logo.svg',
					mimeType: 'image/svg+xml',
					size: 3,
					blobRef: 'blob-original',
				}),
				processingSchema,
			)
			await waitForStatus(fixture.harness, upload.uploadId, 'ready')
			await session.waitForIdle()

			const message = attachmentMessage(fixture.harness)
			const basePath = basePathOf(message)
			expect(message).toBe(
				`<attachment uploadId="${upload.uploadId}" filename="logo.svg" type="image/svg+xml" basePath="${basePath}">\n`
					+ '[File uploaded: logo.svg]\n'
					+ `The original is kept by the host and is not readable as a file: ${basePath}/logo.svg does not exist in the session.`
					+ ' There are no files to read; the text above is all that was extracted from it.'
					+ ` To place or publish the original, pass ${basePath}/logo.svg to a host tool that takes it.\n`
					+ '</attachment>',
			)
		} finally {
			await fixture.cleanup()
		}
	})
})
