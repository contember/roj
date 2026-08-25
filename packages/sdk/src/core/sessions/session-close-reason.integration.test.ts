import { describe, expect, it } from 'bun:test'
import type { SessionCloseReason } from '~/core/plugins/plugin-builder.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

const waitUntil = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
		await Bun.sleep(5)
	}
}

const createProbe = () => {
	const reasons: SessionCloseReason[] = []
	const plugin = definePlugin('close-reason-probe')
		.sessionHook('onSessionClose', async (ctx) => {
			reasons.push(ctx.reason)
		})
		.build()
	return { reasons, plugin }
}

const createFailingReadyProbe = () => {
	const reasons: SessionCloseReason[] = []
	const plugin = definePlugin('failing-ready-probe')
		.sessionHook('onSessionReady', async () => {
			throw new Error('ready hook exploded')
		})
		.sessionHook('onSessionClose', async (ctx) => {
			reasons.push(ctx.reason)
		})
		.build()
	return { reasons, plugin }
}

describe('onSessionClose reason', () => {
	it('reports evicted when the idle sweep parks a runtime', async () => {
		const { reasons, plugin } = createProbe()
		const harness = new TestHarness({
			presets: [createTestPreset()],
			systemPlugins: [plugin],
			sessionIdleTimeoutMs: 15,
		})
		try {
			await harness.createSession('test')
			await waitUntil(() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0)
			expect(reasons).toEqual(['evicted'])
		} finally {
			await harness.shutdown()
		}
	})

	it('reports closed when the session itself is closed', async () => {
		const { reasons, plugin } = createProbe()
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [plugin] })
		try {
			const session = await harness.createSession('test')
			await session.close()
			expect(reasons).toEqual(['closed'])
		} finally {
			await harness.shutdown()
		}
	})

	it('reports shutdown when the manager shuts down', async () => {
		const { reasons, plugin } = createProbe()
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [plugin] })
		await harness.createSession('test')
		await harness.shutdown()
		expect(reasons).toEqual(['shutdown'])
	})

	it('defaults a bare runtime dispose to evicted, and honours an explicit closed', async () => {
		const { reasons, plugin } = createProbe()
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [plugin] })
		try {
			const parked = await harness.createSession('test')
			const parkedSession = await harness.sessionManager.getSession(parked.sessionId)
			if (!parkedSession.ok) throw new Error(parkedSession.error.message)
			await parkedSession.value.dispose()
			expect(reasons).toEqual(['evicted'])

			const ended = await harness.createSession('test')
			const endedSession = await harness.sessionManager.getSession(ended.sessionId)
			if (!endedSession.ok) throw new Error(endedSession.error.message)
			await endedSession.value.dispose('closed')
			expect(reasons).toEqual(['evicted', 'closed'])
		} finally {
			await harness.shutdown()
		}
	})

	it('reports evicted when a runtime dies before it is ready', async () => {
		const { reasons, plugin } = createFailingReadyProbe()
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [plugin] })
		try {
			await expect(harness.sessionManager.createSession('test')).rejects.toThrow('ready hook exploded')
			expect(reasons).toEqual(['evicted'])
		} finally {
			await harness.shutdown()
		}
	})

	it('rebuilds a parked runtime and closes it again with its own reason', async () => {
		const { reasons, plugin } = createProbe()
		const harness = new TestHarness({
			presets: [createTestPreset()],
			systemPlugins: [plugin],
			sessionIdleTimeoutMs: 15,
		})
		try {
			const created = await harness.createSession('test')
			await waitUntil(() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0)
			expect(reasons).toEqual(['evicted'])

			const reloaded = await harness.sessionManager.getSession(created.sessionId)
			if (!reloaded.ok) throw new Error(reloaded.error.message)
			await reloaded.value.close()
			expect(reasons).toEqual(['evicted', 'closed'])
		} finally {
			await harness.shutdown()
		}
	})
})
