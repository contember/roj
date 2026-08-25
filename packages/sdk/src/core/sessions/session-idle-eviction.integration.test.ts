import { describe, expect, it, spyOn } from 'bun:test'
import { z } from 'zod/v4'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { SessionRuntimeActivityController } from '~/core/sessions/runtime-activity.js'
import { SessionId } from '~/core/sessions/schema.js'
import { Ok } from '~/lib/utils/result.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

const waitUntil = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
		await Bun.sleep(5)
	}
}

describe('session idle eviction', () => {
	it('shares an explicit-ID creation with a concurrent lookup', async () => {
		let readyCalls = 0
		let releaseReady: (() => void) | undefined
		let markReadyStarted: (() => void) | undefined
		const readyStarted = new Promise<void>((resolve) => {
			markReadyStarted = resolve
		})
		const readyGate = new Promise<void>((resolve) => {
			releaseReady = resolve
		})
		const plugin = definePlugin('gated-ready')
			.sessionHook('onSessionReady', async () => {
				readyCalls++
				markReadyStarted?.()
				await readyGate
			})
			.build()
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [plugin] })
		try {
			const sessionId = SessionId('create-get-race')
			const creating = harness.sessionManager.createSession('test', { sessionId: String(sessionId) })
			await readyStarted
			const getting = harness.sessionManager.getSession(sessionId)
			if (!releaseReady) throw new Error('Ready release was not initialized')
			releaseReady()
			const [created, fetched] = await Promise.all([creating, getting])
			expect(created.ok).toBe(true)
			expect(fetched.ok).toBe(true)
			if (created.ok && fetched.ok) expect(created.value).toBe(fetched.value)
			expect(readyCalls).toBe(1)
		} finally {
			releaseReady?.()
			await harness.shutdown()
		}
	})

	it('makes the unload transition atomic with lease acquisition', () => {
		const activity = new SessionRuntimeActivityController()
		const release = activity.acquire('test')
		expect(activity.tryBeginUnload()).toBe(false)
		release()
		release()
		expect(activity.tryBeginUnload()).toBe(true)
		expect(activity.tryAcquire('late')).toBeNull()
	})

	it('is disabled by default', async () => {
		const harness = new TestHarness({ presets: [createTestPreset()] })
		try {
			await harness.createSession('test')
			await Bun.sleep(30)
			expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(1)
		} finally {
			await harness.shutdown()
		}
	})

	it('evicts idle runtimes without closing persisted sessions and reloads once', async () => {
		let readyCalls = 0
		let closeCalls = 0
		const lifecycleProbe = definePlugin('lifecycle-probe')
			.sessionHook('onSessionReady', async () => {
				readyCalls++
			})
			.sessionHook('onSessionClose', async () => {
				closeCalls++
			})
			.build()
		const harness = new TestHarness({
			presets: [createTestPreset({ workspaceDir: '/tmp' })],
			systemPlugins: [lifecycleProbe],
			sessionIdleTimeoutMs: 15,
		})
		try {
			const created = await harness.createSession('test')
			const sessionId = created.sessionId

			await waitUntil(() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0)
			expect(closeCalls).toBe(1)
			expect(readyCalls).toBe(1)
			const events = await harness.eventStore.load(sessionId)
			expect(events.some((event) => event.type === 'session_closed')).toBe(false)

			const stats = await harness.sessionManager.getStats()
			expect(stats.sessionCount).toBe(1)
			expect(stats.loadedSessionCount).toBe(0)
			expect(stats.sessions[0]?.id).toBe(sessionId)

			const loadSpy = spyOn(harness.eventStore, 'load')
			loadSpy.mockClear()
			const [first, second] = await Promise.all([harness.sessionManager.getSession(sessionId), harness.sessionManager.getSession(sessionId)])
			expect(first.ok).toBe(true)
			expect(second.ok).toBe(true)
			expect(loadSpy).toHaveBeenCalledTimes(1)
			if (first.ok && second.ok) {
				expect(first.value).toBe(second.value)
				expect(first.value.state.presetId).toBe('test')
			}
			expect(readyCalls).toBe(2)
			loadSpy.mockRestore()
		} finally {
			await harness.shutdown()
		}
	})

	it('keeps a runtime resident while a request lease is active', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			sessionIdleTimeoutMs: 10,
		})
		try {
			const created = await harness.createSession('test')
			let releaseRequest: (() => void) | undefined
			const requestGate = new Promise<void>((resolve) => {
				releaseRequest = resolve
			})
			const request = harness.sessionManager.withSessionLease(SessionId(String(created.sessionId)), 'test-request', async () => {
				await requestGate
				return Ok(undefined)
			})

			await waitUntil(() => harness.sessionManager.getRuntimeCacheStats().sessions[0]?.activeLeaseCount === 1)
			await Bun.sleep(35)
			expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(1)

			if (!releaseRequest) throw new Error('Request release was not initialized')
			releaseRequest()
			await request
			await waitUntil(() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0)
		} finally {
			await harness.shutdown()
		}
	})

	it('waits a full timeout after a direct runtime lease is released', async () => {
		let releaseBackground: (() => void) | undefined
		const plugin = definePlugin('background-lease')
			.method('start', {
				input: z.object({}),
				output: z.object({}),
				handler: async (ctx) => {
					releaseBackground = ctx.runtimeActivity.acquire('background:test')
					return Ok({})
				},
			})
			.build()
		const harness = new TestHarness({
			presets: [createTestPreset()],
			systemPlugins: [plugin],
			sessionIdleTimeoutMs: 30,
		})
		try {
			const created = await harness.createSession('test')
			const started = await harness.sessionManager.callPluginMethod(created.sessionId, 'background-lease.start', {})
			expect(started.ok).toBe(true)
			await Bun.sleep(70)
			expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(1)
			if (!releaseBackground) throw new Error('Background release was not initialized')
			releaseBackground()
			await Bun.sleep(15)
			expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(1)
			await waitUntil(() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0)
		} finally {
			releaseBackground?.()
			await harness.shutdown()
		}
	})

	it('reloads after direct disposal and rejects acquisition during shutdown', async () => {
		let closeCalls = 0
		let releaseClose: (() => void) | undefined
		let markCloseStarted: (() => void) | undefined
		const closeStarted = new Promise<void>((resolve) => {
			markCloseStarted = resolve
		})
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve
		})
		const plugin = definePlugin('gated-close')
			.sessionHook('onSessionClose', async () => {
				closeCalls++
				if (closeCalls === 2) {
					markCloseStarted?.()
					await closeGate
				}
			})
			.build()
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [plugin] })
		const created = await harness.createSession('test')
		const first = await harness.sessionManager.getSession(created.sessionId)
		if (!first.ok) throw new Error(first.error.message)
		await first.value.dispose()
		const replacement = await harness.sessionManager.acquireSessionLease(created.sessionId, 'replacement')
		expect(replacement.ok).toBe(true)
		if (replacement.ok) replacement.value.release()
		expect(closeCalls).toBe(1)

		const shutdown = harness.sessionManager.shutdown()
		await closeStarted
		const duringShutdown = await harness.sessionManager.acquireSessionLease(created.sessionId, 'late')
		expect(duringShutdown.ok).toBe(false)
		if (!releaseClose) throw new Error('Close release was not initialized')
		releaseClose()
		await shutdown
		expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
		await harness.shutdown()
	})

	it('keeps replacement listener ownership after disposing the old runtime', async () => {
		let closeCalls = 0
		const plugin = definePlugin('listener-owner')
			.sessionHook('onSessionClose', async () => {
				closeCalls++
			})
			.build()
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [plugin] })
		try {
			const created = await harness.createSession('test')
			const first = await harness.sessionManager.getSession(created.sessionId)
			if (!first.ok) throw new Error(first.error.message)
			await first.value.dispose()
			const replacement = await harness.sessionManager.getSession(created.sessionId)
			if (!replacement.ok) throw new Error(replacement.error.message)
			await replacement.value.close()
			await waitUntil(() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0)
			expect(closeCalls).toBe(2)
		} finally {
			await harness.shutdown()
		}
	})

	it('evicts many idle runtimes while keeping their persisted count', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset()],
			sessionIdleTimeoutMs: 10,
		})
		try {
			await Promise.all(Array.from({ length: 12 }, () => harness.createSession('test')))
			expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(12)
			await waitUntil(() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0)
			const stats = await harness.sessionManager.getStats()
			expect(stats.sessionCount).toBe(12)
			expect(stats.loadedSessionCount).toBe(0)
		} finally {
			await harness.shutdown()
		}
	})

	it('keeps startup recovery eager', async () => {
		const source = new TestHarness({ presets: [createTestPreset()] })
		const created = await source.createSession('test')
		const eventStore = source.eventStore
		await source.shutdown()

		const recovered = new TestHarness({ presets: [createTestPreset()], eventStore })
		try {
			expect(recovered.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
			await recovered.sessionManager.loadAllSessions()
			expect(recovered.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(1)
			const session = await recovered.sessionManager.getSession(created.sessionId)
			expect(session.ok).toBe(true)
		} finally {
			await recovered.shutdown()
		}
	})

	it('loads closed and failed concurrent requests with one event-store read', async () => {
		const source = new TestHarness({ presets: [createTestPreset()] })
		const created = await source.createSession('test')
		await created.close()
		await waitUntil(() => source.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0)
		const loadSpy = spyOn(source.eventStore, 'load')
		loadSpy.mockClear()
		try {
			const closedResults = await Promise.all([source.sessionManager.getSession(created.sessionId), source.sessionManager.getSession(created.sessionId)])
			expect(closedResults.every((result) => result.ok && result.value.state.status === 'closed')).toBe(true)
			expect(loadSpy).toHaveBeenCalledTimes(1)
		} finally {
			loadSpy.mockRestore()
			await source.shutdown()
		}

		const missingPreset = new TestHarness({
			presets: [],
			eventStore: source.eventStore,
		})
		const failedLoadSpy = spyOn(source.eventStore, 'load')
		failedLoadSpy.mockClear()
		try {
			const failedResults = await Promise.all([
				missingPreset.sessionManager.getSession(created.sessionId),
				missingPreset.sessionManager.getSession(created.sessionId),
			])
			expect(failedResults.every((result) => !result.ok && result.error.type === 'preset_not_found')).toBe(true)
			expect(failedLoadSpy).toHaveBeenCalledTimes(1)
		} finally {
			failedLoadSpy.mockRestore()
			await missingPreset.shutdown()
		}
	})
})
