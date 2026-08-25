import { describe, expect, it, spyOn } from 'bun:test'
import z from 'zod/v4'
import { Agent } from '~/core/agents/agent.js'
import { createEventsFactory } from '~/core/events/types.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { SessionRuntimeDetachedError } from '~/core/sessions/session-store.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

const createDeferred = () => {
	let resolveDeferred: (() => void) | undefined
	const promise = new Promise<void>((resolve) => {
		resolveDeferred = resolve
	})
	if (!resolveDeferred) {
		throw new Error('Deferred resolver was not initialized')
	}
	return { promise, resolve: resolveDeferred }
}

const waitForMacrotaskTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

const createHarness = (
	systemPlugins: ConstructorParameters<typeof TestHarness>[0]['systemPlugins'],
	eventStore?: ConstructorParameters<typeof TestHarness>[0]['eventStore'],
) => new TestHarness({
	presets: [createTestPreset()],
	llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
	systemPlugins,
	eventStore,
})

describe('session disposal', () => {
	it('waits for deferred close hooks during manager shutdown', async () => {
		const hookStarted = createDeferred()
		const releaseHook = createDeferred()
		const plugin = definePlugin('deferred-close')
			.sessionHook('onSessionClose', async () => {
				hookStarted.resolve()
				await releaseHook.promise
			})
			.build()
		const harness = createHarness([plugin])
		await harness.createSession('test')

		let shutdownFinished = false
		const shutdown = harness.sessionManager.shutdown().then(() => {
			shutdownFinished = true
		})

		await hookStarted.promise
		await Promise.resolve()
		expect(shutdownFinished).toBe(false)

		releaseHook.resolve()
		await shutdown
		expect(shutdownFinished).toBe(true)

		await harness.shutdown()
	})

	it('keeps manager shutdown pending during a concurrent domain close', async () => {
		const hookStarted = createDeferred()
		const releaseHook = createDeferred()
		const plugin = definePlugin('blocked-domain-close')
			.sessionHook('onSessionClose', async () => {
				hookStarted.resolve()
				await releaseHook.promise
			})
			.build()
		const harness = createHarness([plugin])
		const session = await harness.createSession('test')

		const close = session.close()
		await hookStarted.promise

		let shutdownFinished = false
		const shutdown = harness.sessionManager.shutdown().then(() => {
			shutdownFinished = true
		})
		await waitForMacrotaskTurn()

		try {
			expect(shutdownFinished).toBe(false)
		} finally {
			releaseHook.resolve()
			await Promise.all([close, shutdown])
			await harness.shutdown()
		}

		expect(shutdownFinished).toBe(true)
	})

	it('shares concurrent disposal and cleans hooks and agents once', async () => {
		let hookCalls = 0
		const plugin = definePlugin('counted-close')
			.sessionHook('onSessionClose', async () => {
				hookCalls++
			})
			.build()
		const harness = createHarness([plugin])
		const testSession = await harness.createSession('test')
		const sessionResult = await harness.sessionManager.getSession(testSession.sessionId)
		if (!sessionResult.ok) {
			throw new Error(`Failed to get session: ${sessionResult.error.message}`)
		}

		const shutdownSpy = spyOn(Agent.prototype, 'shutdown')
		shutdownSpy.mockClear()
		try {
			await Promise.all([
				sessionResult.value.dispose(),
				sessionResult.value.dispose(),
			])

			expect(hookCalls).toBe(1)
			expect(shutdownSpy).toHaveBeenCalledTimes(1)
			expect(sessionResult.value.getEntryAgent()).toBeNull()
		} finally {
			shutdownSpy.mockRestore()
			await harness.shutdown()
		}
	})

	it('keeps a gracefully disposed session persisted and reloadable', async () => {
		const firstHarness = createHarness([])
		const testSession = await firstHarness.createSession('test')
		const sessionId = testSession.sessionId
		const eventStore = firstHarness.eventStore

		await firstHarness.shutdown()

		const events = await eventStore.load(sessionId)
		expect(events.some((event) => event.type === 'session_closed')).toBe(false)

		const restartedHarness = createHarness([], eventStore)
		try {
			const reopened = await restartedHarness.openSession(sessionId)
			expect(reopened.state.status).toBe('active')
		} finally {
			await restartedHarness.shutdown()
		}
	})

	it('continues cleanup after a hook failure and does not repeat domain-close cleanup', async () => {
		const calls: string[] = []
		const laterPlugin = definePlugin('later-close')
			.sessionHook('onSessionClose', async () => {
				calls.push('later')
			})
			.build()
		const failingPlugin = definePlugin('failing-close')
			.sessionHook('onSessionClose', async () => {
				calls.push('failing')
				throw new Error('close failed')
			})
			.build()
		const harness = createHarness([laterPlugin, failingPlugin])
		const testSession = await harness.createSession('test')
		const sessionResult = await harness.sessionManager.getSession(testSession.sessionId)
		if (!sessionResult.ok) {
			throw new Error(`Failed to get session: ${sessionResult.error.message}`)
		}

		await testSession.close()

		expect(calls).toEqual(['failing', 'later'])
		expect(sessionResult.value.getEntryAgent()).toBeNull()

		await harness.shutdown()
		expect(calls).toEqual(['failing', 'later'])
	})

	it('refuses an event emitted after the runtime was disposed', async () => {
		const lateEvents = createEventsFactory({ events: { late_write: z.object({ note: z.string() }) } })
		let lateEmit: (() => Promise<void>) | undefined
		const plugin = definePlugin('late-writer')
			.events([lateEvents])
			.sessionHook('onSessionReady', async (ctx) => {
				lateEmit = () => ctx.emitEvent(lateEvents.create('late_write', { note: 'after disposal' }))
			})
			.build()
		const harness = createHarness([plugin])
		const session = await harness.createSession('test')
		if (!lateEmit) throw new Error('Expected the ready hook to capture an emit seam')

		await session.close()

		// The manager rebuilds this session from the log on the next access, so a
		// write from the disposed runtime would be invisible to the live one.
		await expect(lateEmit()).rejects.toBeInstanceOf(SessionRuntimeDetachedError)
		expect(await session.getEventsByType('late_write')).toHaveLength(0)

		await harness.shutdown()
	})

})
