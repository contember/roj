import { describe, expect, it } from 'bun:test'
import type { Logger, RuntimeLeaseRelease, SessionState } from '@roj-ai/sdk'
import { createSessionState, SessionId } from '@roj-ai/sdk'
import { acquirePreviewTarget, type PreviewSession, type PreviewSessionSource, proxyPreview } from './preview-proxy.js'

const silentLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => silentLogger,
	level: 'error',
}

interface FakeService {
	port?: number
	status?: string
}

/** Counts leases the way the real runtime activity does, without a session runtime. */
class FakeSession implements PreviewSession {
	activeLeases = 0
	readonly reasons: string[] = []
	readonly state: SessionState

	constructor(services: Record<string, FakeService>, private readonly ready = true) {
		this.state = Object.assign(createSessionState(SessionId('s-preview'), 'test', 0), {
			services: new Map(Object.entries(services)),
		})
	}

	tryAcquireRuntimeLease(reason: string): RuntimeLeaseRelease | null {
		if (!this.ready) return null
		this.activeLeases++
		this.reasons.push(reason)
		let released = false
		return () => {
			if (released) return
			released = true
			this.activeLeases--
		}
	}
}

const sourceOf = (...sessions: PreviewSession[]): PreviewSessionSource => ({
	listResidentSessions: async () => sessions,
})

describe('preview proxy', () => {
	it('leases the runtime of the session that owns the service', async () => {
		const session = new FakeSession({ dev: { port: 4321, status: 'ready' } })
		const target = await acquirePreviewTarget(sourceOf(session), 'dev')

		expect(target?.port).toBe(4321)
		expect(session.activeLeases).toBe(1)
		expect(session.reasons).toEqual(['preview:dev'])

		target?.release()
		expect(session.activeLeases).toBe(0)
	})

	it('skips a session whose runtime is already unloading', async () => {
		const unloading = new FakeSession({ dev: { port: 4321, status: 'ready' } }, false)
		const ready = new FakeSession({ dev: { port: 4322, status: 'ready' } })

		const target = await acquirePreviewTarget(sourceOf(unloading, ready), 'dev')

		expect(target?.port).toBe(4322)
		expect(ready.activeLeases).toBe(1)
		target?.release()
	})

	it('ignores stopped and failed services', async () => {
		const session = new FakeSession({ dev: { port: 4321, status: 'stopped' }, api: { status: 'ready' } })

		expect(await acquirePreviewTarget(sourceOf(session), 'dev')).toBeNull()
		expect(await acquirePreviewTarget(sourceOf(session), 'api')).toBeNull()
		expect(session.activeLeases).toBe(0)
	})

	it('holds the lease until the proxied body ends', async () => {
		let releaseTail = () => {}
		const tailSent = new Promise<void>((resolve) => {
			releaseTail = resolve
		})
		const upstream = Bun.serve({
			port: 0,
			fetch: () => new Response(new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(new TextEncoder().encode('head'))
					await tailSent
					controller.enqueue(new TextEncoder().encode('tail'))
					controller.close()
				},
			})),
		})
		const session = new FakeSession({ dev: { port: upstream.port, status: 'ready' } })

		try {
			const response = await proxyPreview(
				new Request('http://local/preview/dev/index.html'),
				'/preview/',
				sourceOf(session),
				silentLogger,
			)
			expect(response.status).toBe(200)
			const reader = response.body?.getReader()
			if (!reader) throw new Error('Expected a streamed body')

			const head = await reader.read()
			expect(new TextDecoder().decode(head.value)).toBe('head')
			// Eviction must not stop the service under an open response.
			expect(session.activeLeases).toBe(1)

			releaseTail()
			const tail = await reader.read()
			expect(new TextDecoder().decode(tail.value)).toBe('tail')
			expect((await reader.read()).done).toBe(true)
			expect(session.activeLeases).toBe(0)
		} finally {
			releaseTail()
			await upstream.stop(true)
		}
	})

	it('releases the lease when the consumer cancels the body', async () => {
		const upstream = Bun.serve({
			port: 0,
			fetch: () => new Response(new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('head'))
				},
			})),
		})
		const session = new FakeSession({ dev: { port: upstream.port, status: 'ready' } })

		try {
			const response = await proxyPreview(
				new Request('http://local/preview/dev/index.html'),
				'/preview/',
				sourceOf(session),
				silentLogger,
			)
			const reader = response.body?.getReader()
			if (!reader) throw new Error('Expected a streamed body')
			await reader.read()
			await reader.cancel('client went away')

			expect(session.activeLeases).toBe(0)
		} finally {
			await upstream.stop(true)
		}
	})

	it('releases the lease when the upstream cannot be reached', async () => {
		const closed = Bun.serve({ port: 0, fetch: () => new Response('unused') })
		const port = closed.port
		await closed.stop(true)
		const session = new FakeSession({ dev: { port, status: 'ready' } })

		const response = await proxyPreview(
			new Request('http://local/preview/dev/index.html'),
			'/preview/',
			sourceOf(session),
			silentLogger,
		)

		expect(response.status).toBe(502)
		expect(session.activeLeases).toBe(0)
	})
})
