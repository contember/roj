import { describe, expect, it } from 'bun:test'
import { z } from 'zod/v4'
import { SessionErrors, ValidationErrors } from '~/core/errors.js'
import { ModelId } from '~/core/llm/schema.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import type { SessionState } from '~/core/sessions/state.js'
import { getEntryAgentId } from '~/core/sessions/state.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { generateMessageId } from '~/plugins/mailbox/schema.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

const waitUntil = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
		await Bun.sleep(5)
	}
}

describe('session context live seams', () => {
	it('keeps hook state as a snapshot while exposing live state and monotonic reservations', async () => {
		const observed: {
			snapshot?: SessionState
			getSessionState?: () => SessionState
			reserveMailboxMessageSequence?: () => number
		} = {}
		const plugin = definePlugin('session-context-probe')
			.sessionHook('onSessionReady', async (ctx) => {
				observed.snapshot = ctx.sessionState
				observed.getSessionState = ctx.getSessionState
				observed.reserveMailboxMessageSequence = ctx.reserveMailboxMessageSequence
			})
			.build()
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [plugin] })
		try {
			const session = await harness.createSession('test')
			const snapshot = observed.snapshot
			const getSessionState = observed.getSessionState
			const reserveMailboxMessageSequence = observed.reserveMailboxMessageSequence
			if (!snapshot || !getSessionState || !reserveMailboxMessageSequence) throw new Error('Session context was not observed')

			const first = reserveMailboxMessageSequence()
			const second = reserveMailboxMessageSequence()
			expect(first).toBe(1)
			expect(second).toBe(first + 1)

			const model = ModelId('live-model')
			await session.setOverrides({ defaults: { model } })
			expect(snapshot.overrides.defaults).toBeUndefined()
			expect(getSessionState()).not.toBe(snapshot)
			expect(getSessionState().overrides.defaults?.model).toBe(model)
		} finally {
			await harness.shutdown()
		}
	})

	it('keeps named sequences independent and seeds each one once per runtime', async () => {
		const observed: { reserve?: (name: string, seed: () => number) => number } = {}
		const seedCalls = { a: 0, b: 0 }
		const plugin = definePlugin('sequence-probe')
			.sessionHook('onSessionReady', async (ctx) => {
				observed.reserve = ctx.reserveSequence
			})
			.build()
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [plugin] })
		try {
			await harness.createSession('test')
			const reserve = observed.reserve
			if (!reserve) throw new Error('Session context was not observed')

			const seedA = () => {
				seedCalls.a++
				return 10
			}
			const seedB = () => {
				seedCalls.b++
				return 100
			}

			expect(reserve('a', seedA)).toBe(10)
			expect(reserve('a', seedA)).toBe(11)
			expect(reserve('b', seedB)).toBe(100)
			expect(reserve('a', seedA)).toBe(12)
			expect(reserve('b', seedB)).toBe(101)
			// The seed only hands a rebuilt runtime its starting point; after that the counter owns it.
			expect(seedCalls).toEqual({ a: 1, b: 1 })
		} finally {
			await harness.shutdown()
		}
	})

	it('uses the reserved mailbox sequence when manually spawning an agent', async () => {
		const harness = new TestHarness({
			presets: [createTestPreset({
				agents: [{ name: 'worker', system: 'Worker', tools: [], agents: [], debounceMs: 10_000 }],
			})],
		})
		try {
			const session = await harness.createSession('test')
			const parentId = session.getEntryAgentId()
			if (!parentId) throw new Error('Entry agent was not created')
			const loaded = await harness.sessionManager.getSession(session.sessionId)
			if (!loaded.ok) throw new Error(loaded.error.message)

			const spawned = await loaded.value.spawnAgentManually('worker', parentId, 'first task')
			expect(spawned.ok).toBe(true)
			const messages = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			const spawnMessage = messages.find((event) => event.message.content === 'first task')
			expect(spawnMessage?.sequence).toBe(1)
			expect(spawnMessage?.message.id).toBe(generateMessageId(1))
		} finally {
			await harness.shutdown()
		}
	})

	it('rejects a closed-session plugin write before reservation or emission', async () => {
		let handlerCalls = 0
		let reserveMailboxMessageSequence: (() => number) | undefined
		const plugin = definePlugin('closed-writer')
			.sessionHook('onSessionReady', async (ctx) => {
				reserveMailboxMessageSequence = ctx.reserveMailboxMessageSequence
			})
			.method('write', {
				input: z.object({}),
				output: z.object({}),
				handler: async (ctx) => {
					if (ctx.getSessionState().status === 'closed') return Err(SessionErrors.closed(String(ctx.sessionId)))
					handlerCalls++
					const toAgentId = getEntryAgentId(ctx.getSessionState())
					if (!toAgentId) return Err(ValidationErrors.invalid('Entry agent not found'))
					const sequence = ctx.reserveMailboxMessageSequence()
					await ctx.emitEvent(mailboxEvents.create('mailbox_message', {
						toAgentId,
						sequence,
						message: {
							id: generateMessageId(sequence),
							from: 'debug',
							content: 'late write',
							timestamp: Date.now(),
							consumed: false,
						},
					}))
					return Ok({})
				},
			})
			.build()
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [plugin] })
		try {
			const session = await harness.createSession('test')
			await session.close()
			if (!reserveMailboxMessageSequence) throw new Error('Reservation function was not observed')
			const reserveAfterClose = reserveMailboxMessageSequence
			expect(() => reserveAfterClose()).toThrow('closed or disposed')
			const result = await session.callPluginMethod('closed-writer.write', {})
			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.error.type).toBe('session_closed')
			expect(handlerCalls).toBe(0)
			const messages = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			expect(messages).toHaveLength(0)
		} finally {
			await harness.shutdown()
		}
	})

	it('continues mailbox reservations after idle replay high-water', async () => {
		const plugin = definePlugin('sequence-writer')
			.method('write', {
				input: z.object({ content: z.string() }),
				output: z.object({ sequence: z.number() }),
				handler: async (ctx, input) => {
					if (ctx.getSessionState().status === 'closed') return Err(SessionErrors.closed(String(ctx.sessionId)))
					const toAgentId = getEntryAgentId(ctx.getSessionState())
					if (!toAgentId) return Err(ValidationErrors.invalid('Entry agent not found'))
					const sequence = ctx.reserveMailboxMessageSequence()
					await ctx.emitEvent(mailboxEvents.create('mailbox_message', {
						toAgentId,
						sequence,
						message: {
							id: generateMessageId(sequence),
							from: 'debug',
							content: input.content,
							timestamp: Date.now(),
							consumed: false,
						},
					}))
					return Ok({ sequence })
				},
			})
			.build()
		const harness = new TestHarness({
			presets: [createTestPreset()],
			systemPlugins: [plugin],
			sessionIdleTimeoutMs: 10,
		})
		try {
			const session = await harness.createSession('test')
			expect((await session.callPluginMethod('sequence-writer.write', { content: 'before reload' })).ok).toBe(true)
			await waitUntil(() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0)
			expect((await harness.sessionManager.callPluginMethod(
				session.sessionId,
				'sequence-writer.write',
				{ content: 'after reload' },
			)).ok).toBe(true)

			const messages = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			expect(messages.map((event) => event.sequence)).toEqual([1, 2])
			expect(messages.map((event) => event.message.id)).toEqual([generateMessageId(1), generateMessageId(2)])
		} finally {
			await harness.shutdown()
		}
	})

	it('registers a directly reopened closed runtime as the manager-owned instance', async () => {
		let readyCalls = 0
		const plugin = definePlugin('direct-reopen-probe')
			.sessionHook('onSessionReady', async () => {
				readyCalls++
			})
			.build()
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [plugin] })
		try {
			const session = await harness.createSession('test')
			await session.close()
			const closed = await harness.sessionManager.getSession(session.sessionId)
			if (!closed.ok) throw new Error(closed.error.message)

			const reopening = closed.value.reopen()
			const getting = harness.sessionManager.getSession(session.sessionId)
			const [reopened, fetched] = await Promise.all([reopening, getting])
			expect(reopened.ok).toBe(true)
			expect(fetched.ok).toBe(true)
			if (fetched.ok) expect(fetched.value).toBe(closed.value)
			expect(readyCalls).toBe(2)
			expect(harness.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(1)
		} finally {
			await harness.shutdown()
		}
	})

	it('shares a plugin reopen with a concurrent lookup and installs one listener', async () => {
		let readyCalls = 0
		const readyStarted = Promise.withResolvers<void>()
		const releaseReady = Promise.withResolvers<void>()
		const plugin = definePlugin('gated-reopen-probe')
			.sessionHook('onSessionReady', async () => {
				readyCalls++
				if (readyCalls === 2) {
					readyStarted.resolve()
					await releaseReady.promise
				}
			})
			.build()
		const harness = new TestHarness({ presets: [createTestPreset()], systemPlugins: [plugin] })
		try {
			const session = await harness.createSession('test')
			await session.close()
			const closed = await harness.sessionManager.getSession(session.sessionId)
			if (!closed.ok) throw new Error(closed.error.message)

			const reopening = closed.value.callPluginMethod('sessions.reopen', {})
			await readyStarted.promise
			const getting = harness.sessionManager.getSession(session.sessionId)
			expect(harness.sessionManager.getRuntimeCacheStats().sessions[0]?.state).toBe('loading')
			releaseReady.resolve()
			const [reopened, fetched] = await Promise.all([reopening, getting])
			expect(reopened.ok).toBe(true)
			expect(fetched.ok).toBe(true)
			if (fetched.ok) {
				expect(fetched.value).toBe(closed.value)
				await fetched.value.close()
			}
			await waitUntil(() => harness.sessionManager.getRuntimeCacheStats().loadedSessionCount === 0)
			expect(readyCalls).toBe(2)
		} finally {
			releaseReady.resolve()
			await harness.shutdown()
		}
	})
})
