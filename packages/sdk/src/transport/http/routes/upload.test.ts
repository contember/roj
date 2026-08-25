/**
 * Upload Route Tests
 *
 * The routes take a session lease as their first statement, so every early
 * return has to give it back. Eviction is on here — with it off the lease
 * bookkeeping these assertions read is never populated.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { bootstrap, createSessionManager } from '~/bootstrap.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { SessionManager } from '~/core/sessions/session-manager.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { bootstrapForTesting } from '../../../testing/bootstrap-for-testing.js'
import type { AppEnv } from '../context.js'
import { createUploadRoutes } from './upload.js'

describe('upload routes', () => {
	let app: Hono<AppEnv>
	let harness: TestHarness

	beforeEach(() => {
		harness = new TestHarness({
			presets: [createTestPreset()],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			sessionIdleTimeoutMs: 60_000,
		})

		const baseServices = bootstrapForTesting(undefined, [createTestPreset()])

		app = new Hono<AppEnv>()
		app.use('*', async (c, next) => {
			c.set('services', {
				...baseServices,
				sessionRuntime: harness.sessionManager,
			})
			await next()
		})
		app.route('/sessions', createUploadRoutes())
	})

	afterEach(async () => {
		await harness.shutdown()
	})

	function httpLeaseReasons(): string[] {
		return harness.sessionManager.getRuntimeCacheStats().sessions
			.flatMap(session => Object.keys(session.leaseReasons))
			.filter(reason => reason.startsWith('http:'))
	}

	it('releases the lease when multipart parsing fails', async () => {
		const session = await harness.createSession('test')

		const res = await app.request(`/sessions/${session.sessionId}/upload`, {
			method: 'POST',
			headers: { 'Content-Type': 'multipart/form-data; boundary=----roj' },
			body: 'not a multipart body',
		})

		expect(res.status).toBe(400)
		expect(await res.json()).toMatchObject({ error: { type: 'parse_error' } })
		expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(1)
		expect(httpLeaseReasons()).toEqual([])
	})

	it('releases the lease when the async variant fails to parse', async () => {
		const session = await harness.createSession('test')

		const res = await app.request(`/sessions/${session.sessionId}/upload-async`, {
			method: 'POST',
			headers: { 'Content-Type': 'multipart/form-data; boundary=----roj' },
			body: 'not a multipart body',
		})

		expect(res.status).toBe(400)
		expect(httpLeaseReasons()).toEqual([])
	})

	it('rejects a session id that could escape the data root before loading anything', async () => {
		const res = await app.request(`/sessions/${encodeURIComponent('../..')}/upload`, {
			method: 'POST',
			headers: { 'Content-Type': 'multipart/form-data; boundary=----roj' },
			body: 'not a multipart body',
		})

		expect(res.status).toBe(400)
		const body = await res.text()
		expect(body).toContain('validation_error')
		expect(body).not.toContain('..')
		expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
	})

	it('rejects an escaping session id on the download route', async () => {
		const res = await app.request(`/sessions/${encodeURIComponent('../..')}/uploads/some-id/file.txt`)

		expect(res.status).toBe(400)
		expect(await res.json()).toMatchObject({ error: { type: 'validation_error' } })
	})
})

/**
 * Download route — path containment.
 *
 * The route serves whatever the three path params point at, so it needs a real
 * store over a real directory: a symlink or a `%2F` only shows up on disk.
 */
describe('upload download route', () => {
	interface DownloadFixture {
		app: Hono<AppEnv>
		dataDir: string
		outsideDir: string
		sessionRuntime: SessionManager
	}

	// Shapes only — the route must not need either to exist to answer safely.
	const sessionId = 'download-route-session'
	const uploadId = '0198f0c0-0000-7000-8000-00000000abcd'
	let fixture: DownloadFixture | undefined

	async function createDownloadFixture(): Promise<DownloadFixture> {
		const dataDir = await mkdtemp(join(tmpdir(), 'roj-upload-data-'))
		const outsideDir = await mkdtemp(join(tmpdir(), 'roj-upload-outside-'))

		const services = bootstrap({
			port: 0,
			host: 'localhost',
			dataPath: dataDir,
			persistence: 'memory',
			logLevel: 'error',
			logFormat: 'console',
			llmMock: () => ({
				content: 'Mock response',
				toolCalls: [],
				finishReason: 'stop',
				metrics: { promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0, model: 'mock' },
			}),
		}, { presets: [createTestPreset()] }, createNodePlatform())
		const sessionRuntime = createSessionManager(services)

		const downloadApp = new Hono<AppEnv>()
		downloadApp.use('*', async (c, next) => {
			c.set('services', { ...services, sessionRuntime })
			await next()
		})
		downloadApp.route('/sessions', createUploadRoutes())

		return { app: downloadApp, dataDir, outsideDir, sessionRuntime }
	}

	function currentFixture(): DownloadFixture {
		if (!fixture) throw new Error('Test fixture is not initialized')
		return fixture
	}

	function uploadDir(): string {
		return join(currentFixture().dataDir, 'sessions', sessionId, 'uploads', uploadId)
	}

	beforeEach(async () => {
		fixture = await createDownloadFixture()
		await mkdir(uploadDir(), { recursive: true })
		await writeFile(join(uploadDir(), 'hello.txt'), 'hello')
	})

	afterEach(async () => {
		if (!fixture) return
		await fixture.sessionRuntime.shutdown()
		await rm(fixture.dataDir, { recursive: true, force: true })
		await rm(fixture.outsideDir, { recursive: true, force: true })
		fixture = undefined
	})

	it('serves a stored upload', async () => {
		const { app: downloadApp } = currentFixture()

		const res = await downloadApp.request(`/sessions/${sessionId}/uploads/${uploadId}/hello.txt`)

		expect(res.status).toBe(200)
		expect(await res.text()).toBe('hello')
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
	})

	it('rejects an upload symlink that escapes the upload directory', async () => {
		const { app: downloadApp, dataDir } = currentFixture()
		await writeFile(join(dataDir, 'other-session-data.txt'), 'ESCAPED-INSIDE-DATA-ROOT')
		await symlink(join(dataDir, 'other-session-data.txt'), join(uploadDir(), 'escape.txt'))

		const res = await downloadApp.request(`/sessions/${sessionId}/uploads/${uploadId}/escape.txt`)

		expect(res.status).toBe(403)
		expect(await res.text()).not.toContain('ESCAPED-INSIDE-DATA-ROOT')
	})

	it('rejects an upload symlink that escapes the data root', async () => {
		const { app: downloadApp, outsideDir } = currentFixture()
		await writeFile(join(outsideDir, 'host-secret.txt'), 'ESCAPED-OUTSIDE-DATA-ROOT')
		await symlink(join(outsideDir, 'host-secret.txt'), join(uploadDir(), 'host.txt'))

		const res = await downloadApp.request(`/sessions/${sessionId}/uploads/${uploadId}/host.txt`)

		expect(res.status).toBe(403)
		expect(await res.text()).not.toContain('ESCAPED-OUTSIDE-DATA-ROOT')
	})

	it('serves a symlink that stays inside the upload directory', async () => {
		const { app: downloadApp } = currentFixture()
		await symlink(join(uploadDir(), 'hello.txt'), join(uploadDir(), 'alias.txt'))

		const res = await downloadApp.request(`/sessions/${sessionId}/uploads/${uploadId}/alias.txt`)

		expect(res.status).toBe(200)
		expect(await res.text()).toBe('hello')
	})

	it('rejects an upload id whose encoded slash reaches another session', async () => {
		const { app: downloadApp, dataDir } = currentFixture()
		const victimEvents = join(dataDir, 'sessions', 'victim-session', '.events')
		await mkdir(victimEvents, { recursive: true })
		await writeFile(join(victimEvents, 'events.jsonl'), '{"type":"message","text":"VICTIM-TRANSCRIPT-LINE"}\n')

		// `%2F` survives Hono's route matching and only decodes at `c.req.param`.
		const escapingId = encodeURIComponent('../../victim-session/.events')
		const res = await downloadApp.request(`/sessions/${sessionId}/uploads/${escapingId}/events.jsonl`)

		expect(res.status).toBe(400)
		const body = await res.text()
		expect(body).toContain('validation_error')
		expect(body).not.toContain('VICTIM-TRANSCRIPT-LINE')
	})

	it('rejects an upload id that walks out of the data root without throwing', async () => {
		const { app: downloadApp } = currentFixture()

		const res = await downloadApp.request(`/sessions/${sessionId}/uploads/${encodeURIComponent('../../../..')}/passwd`)

		// A 500 here is the throwing `scoped()` call, which is itself the bug.
		expect(res.status).toBe(400)
		expect(await res.json()).toMatchObject({ error: { type: 'validation_error' } })
	})

	it('rejects a filename carrying a path separator', async () => {
		const { app: downloadApp } = currentFixture()
		await mkdir(join(uploadDir(), 'sub'), { recursive: true })
		await writeFile(join(uploadDir(), 'sub', 'nested.txt'), 'NESTED-UPLOAD-BODY')

		const res = await downloadApp.request(
			`/sessions/${sessionId}/uploads/${uploadId}/${encodeURIComponent('sub/nested.txt')}`,
		)

		expect(res.status).toBe(400)
		expect(await res.text()).not.toContain('NESTED-UPLOAD-BODY')
	})

	it('rejects a filename that walks up out of the upload directory', async () => {
		const { app: downloadApp } = currentFixture()

		const res = await downloadApp.request(
			`/sessions/${sessionId}/uploads/${uploadId}/${encodeURIComponent('../../../events.jsonl')}`,
		)

		expect(res.status).toBe(400)
	})

	it('serves a file whose name is not Latin-1 encodable', async () => {
		const { app: downloadApp } = currentFixture()
		const filename = '報告-🙂.txt'
		await writeFile(join(uploadDir(), filename), 'unicode body')

		// `new Response` throws on a non-Latin-1 header value, so a bare `filename=` turns this into a 500.
		const res = await downloadApp.request(`/sessions/${sessionId}/uploads/${uploadId}/${encodeURIComponent(filename)}`)

		expect(res.status).toBe(200)
		expect(await res.text()).toBe('unicode body')
		const disposition = res.headers.get('Content-Disposition')
		expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(filename)}`)
		expect(disposition).toContain('filename="')
	})

	it('keeps a quote out of the Content-Disposition fallback', async () => {
		const { app: downloadApp } = currentFixture()
		const filename = 'a"b.txt'
		await writeFile(join(uploadDir(), filename), 'quoted body')

		const res = await downloadApp.request(`/sessions/${sessionId}/uploads/${uploadId}/${encodeURIComponent(filename)}`)

		expect(res.status).toBe(200)
		const disposition = res.headers.get('Content-Disposition')
		expect(disposition).toBe(`inline; filename="a_b.txt"; filename*=UTF-8''a%22b.txt`)
	})

	it('keeps a missing upload file as not found', async () => {
		const { app: downloadApp } = currentFixture()

		const res = await downloadApp.request(`/sessions/${sessionId}/uploads/${uploadId}/missing.txt`)

		expect(res.status).toBe(404)
	})
})
