import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { bootstrap, createSessionManager } from '../../../bootstrap.js'
import { createTestPreset } from '../../../testing/preset-helpers.js'
import { createNodePlatform } from '../../../testing/node-platform.js'
import type { AppEnv, AppServices } from '../context.js'
import { createFileRoutes } from './files.js'

interface FileRouteFixture {
	app: Hono<AppEnv>
	baseDir: string
	sessionDir: string
	sessionId: string
	workspaceDir: string
	services: AppServices
}

async function createFixture(): Promise<FileRouteFixture> {
	const baseDir = await mkdtemp(join(tmpdir(), 'roj-file-routes-'))
	const workspaceDir = join(baseDir, 'workspace')
	await mkdir(workspaceDir)

	const services = bootstrap({
		port: 0,
		host: 'localhost',
		dataPath: baseDir,
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
	const sessionResult = await sessionRuntime.createSession('test', { workspaceDir })
	if (!sessionResult.ok) {
		await rm(baseDir, { recursive: true, force: true })
		throw new Error(`Failed to create test session: ${sessionResult.error.message}`)
	}

	const appServices: AppServices = { ...services, sessionRuntime }
	const app = new Hono<AppEnv>()
	app.use('*', async (c, next) => {
		c.set('services', appServices)
		await next()
	})
	app.route('/sessions', createFileRoutes())

	const sessionId = String(sessionResult.value.id)
	const sessionDir = join(baseDir, 'sessions', sessionId)
	await mkdir(sessionDir, { recursive: true })

	return { app, baseDir, sessionDir, sessionId, workspaceDir, services: appServices }
}

describe('file routes', () => {
	let fixture: FileRouteFixture | undefined

	beforeEach(async () => {
		fixture = await createFixture()
	})

	afterEach(async () => {
		if (!fixture) return
		await fixture.services.sessionRuntime.shutdown()
		await rm(fixture.baseDir, { recursive: true, force: true })
		fixture = undefined
	})

	function currentFixture(): FileRouteFixture {
		if (!fixture) throw new Error('Test fixture is not initialized')
		return fixture
	}

	it('serves a normal session file', async () => {
		const { app, sessionDir, sessionId } = currentFixture()
		await writeFile(join(sessionDir, 'hello.txt'), 'hello')

		const response = await app.request(`/sessions/${sessionId}/files/hello.txt`)

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe('text/plain')
		expect(await response.text()).toBe('hello')
	})

	it('serves an internal session symlink', async () => {
		const { app, sessionDir, sessionId } = currentFixture()
		await writeFile(join(sessionDir, 'target.txt'), 'internal')
		await symlink(join(sessionDir, 'target.txt'), join(sessionDir, 'link.txt'))

		const response = await app.request(`/sessions/${sessionId}/files/link.txt`)

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('internal')
	})

	it('rejects a session symlink that escapes the session root', async () => {
		const { app, baseDir, sessionDir, sessionId } = currentFixture()
		const outsidePath = join(baseDir, 'outside-session.txt')
		await writeFile(outsidePath, 'secret')
		await symlink(outsidePath, join(sessionDir, 'escape.txt'))

		const response = await app.request(`/sessions/${sessionId}/files/escape.txt`)

		expect(response.status).toBe(403)
	})

	it('rejects a workspace symlink that escapes the workspace root', async () => {
		const { app, baseDir, sessionId, workspaceDir } = currentFixture()
		const outsidePath = join(baseDir, 'outside-workspace.txt')
		await writeFile(outsidePath, 'secret')
		await symlink(outsidePath, join(workspaceDir, 'escape.txt'))

		const response = await app.request(`/sessions/${sessionId}/workspace/escape.txt`)

		expect(response.status).toBe(403)
	})

	it('rejects lexical parent traversal', async () => {
		const { app, sessionId } = currentFixture()
		const traversal = encodeURIComponent('../../outside.txt')

		const response = await app.request(`/sessions/${sessionId}/files/${traversal}`)

		expect(response.status).toBe(403)
	})

	it('rejects a session id whose encoded slash escapes the sessions root', async () => {
		const { app, baseDir } = currentFixture()
		await writeFile(join(baseDir, 'outside-sessions.txt'), 'TOP-SECRET-OUTSIDE-DATA-ROOT')

		// `%2F` survives Hono's route matching and only decodes at `c.req.param`, so the
		// id used to be joined into the path after `preventTraversal` had picked its root.
		const escapingId = encodeURIComponent(`../../${basename(baseDir)}`)
		const response = await app.request(`/sessions/${escapingId}/files/outside-sessions.txt`)

		expect(response.status).toBe(400)
		const body = await response.text()
		expect(body).not.toContain('TOP-SECRET-OUTSIDE-DATA-ROOT')
		expect(body).not.toContain(basename(baseDir))
	})

	it('rejects a session id whose encoded slash escapes the workspace route', async () => {
		const { app } = currentFixture()

		const response = await app.request(`/sessions/${encodeURIComponent('../..')}/workspace/escape.txt`)

		expect(response.status).toBe(400)
	})

	it('marks served files as non-sniffable', async () => {
		const { app, sessionDir, sessionId } = currentFixture()
		await writeFile(join(sessionDir, 'page.html'), '<script>alert(1)</script>')

		const response = await app.request(`/sessions/${sessionId}/files/page.html`)

		expect(response.status).toBe(200)
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
		expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox")
	})

	it('keeps missing files as not found', async () => {
		const { app, sessionId } = currentFixture()

		const response = await app.request(`/sessions/${sessionId}/files/missing.txt`)

		expect(response.status).toBe(404)
	})
})
