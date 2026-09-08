import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { definePlugin } from '../plugins/plugin-builder.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { MockLLMProvider } from '../llm/mock.js'
import { Ok } from '~/lib/utils/result.js'
import { SessionRuntimeUnavailableError } from './runtime-activity.js'
import { SessionId } from './schema.js'
import { sessionEvents } from './state.js'
import { MemoryEventStore } from '../events/memory.js'
import type { DomainEvent } from '../events/types.js'
import { agentsPlugin } from '~/plugins/agents/plugin.js'
import { agentIdSchema } from '../agents/schema.js'
import { SessionRuntimeDetachedError } from './session-store.js'
import { pluginWakeKey } from '../wake-key.js'

function harness(plugins: ConstructorParameters<typeof TestHarness>[0]['systemPlugins'] = []) {
	return new TestHarness({
		presets: [createTestPreset()],
		llmProvider: MockLLMProvider.withFixedResponse({ content: 'ok', toolCalls: [] }),
		systemPlugins: plugins,
	})
}

describe('session park after a recovered failure', () => {
	it('reports a transient wake failure once, then parks on the next attempt', async () => {
		let failNextWake = true
		const waker = definePlugin('waker').method('arm', {
			input: z.object({}), output: z.object({}),
			handler: async (ctx) => {
				// Fire-and-forget, the way a plugin arms a wake it does not wait on.
				void ctx.platform.scheduler.wake(pluginWakeKey(ctx.sessionId, 'waker', 'tick'), 60_000).catch(() => {})
				return Ok({})
			},
		}).build()
		const host = new TestHarness({
			presets: [createTestPreset({ plugins: [waker.configure({})] })],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'ok', toolCalls: [] }),
			systemPlugins: [waker],
			scheduler: {
				wake: async () => {
					if (!failNextWake) return
					failNextWake = false
					throw new Error('durable scheduler blip')
				},
				cancel: async () => {},
			},
		})
		try {
			const session = await host.createSession('test')
			const activation = host.sessionManager.activateSession(session.sessionId)
			if (!activation.ok) throw new Error(activation.error.message)
			await session.callPluginMethod('waker.arm', {})

			// The wake never armed, so the first park must say so.
			await expect(host.sessionManager.parkSession(activation.value)).rejects.toBeInstanceOf(AggregateError)
			// The blip is settled history: retaining it would refuse every later park and
			// leave the host no way to hand the session off gracefully.
			await host.sessionManager.parkSession(activation.value)
			expect(host.sessionManager.activateSession(session.sessionId).ok).toBe(true)
		} finally { await host.shutdown() }
	})
})

describe('session activation handoff', () => {
	function heldFileWrite() {
		const writeEntered = Promise.withResolvers<void>()
		const releaseWrite = Promise.withResolvers<void>()
		const closeEntered = Promise.withResolvers<void>()
		const releaseClose = Promise.withResolvers<void>()
		let contexts = 0
		let closes = 0
		const plugin = definePlugin('held-file').context(() => { contexts++; return {} })
			.method('write', {
				input: z.object({}), output: z.object({}),
				handler: async (ctx) => {
					const written = await ctx.files.session.write('held.txt', 'old effect')
					if (!written.ok) throw new Error(written.error)
					return Ok({})
				},
			}).sessionHook('onSessionClose', async () => {
				closes++
				closeEntered.resolve()
				await releaseClose.promise
			}).build()
		const host = harness([plugin])
		const fs = host.sessionManager.getPlatform().fs
		const writeFile = fs.writeFile.bind(fs)
		fs.writeFile = async (path, data) => {
			if (path.endsWith('/held.txt')) { writeEntered.resolve(); await releaseWrite.promise }
			await writeFile(path, data)
		}
		return { host, writeEntered, releaseWrite, closeEntered, releaseClose, counts: () => ({ contexts, closes }) }
	}

	it('rechecks admission after disposal before replacing a runtime with an issued file write', async () => {
		const gates = heldFileWrite()
		const { host } = gates
		try {
			const created = await host.createSession('test')
			const old = await host.sessionManager.getSession(created.sessionId)
			if (!old.ok) throw new Error(old.error.message)
			const writing = created.callPluginMethod('held-file.write', {})
			await gates.writeEntered.promise
			const closing = created.close()
			await gates.closeEntered.promise
			const loading = host.sessionManager.getSession(created.sessionId)
			gates.releaseClose.resolve()
			await closing
			expect(await loading).toMatchObject({ ok: false, error: { type: 'session_runtime_unavailable' } })
			expect(gates.counts()).toEqual({ contexts: 1, closes: 1 })
			expect(host.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
			gates.releaseWrite.resolve()
			expect((await writing).ok).toBe(true)
			const fresh = await host.sessionManager.getSession(created.sessionId)
			if (!fresh.ok) throw new Error(fresh.error.message)
			expect(fresh.value).not.toBe(old.value)
			expect(gates.counts().contexts).toBe(2)
		} finally {
			gates.releaseWrite.resolve()
			gates.releaseClose.resolve()
			await host.shutdown()
		}
	})

	for (const timing of ['during-close', 'after-close', 'after-revoke']) {
		it(`retains failed park with an issued file write ${timing} until explicit revoke and reacquisition`, async () => {
			const gates = heldFileWrite()
			const { host } = gates
			try {
				const created = await host.createSession('test')
				const activation = host.sessionManager.activateSession(created.sessionId)
				const loaded = await host.sessionManager.getSession(created.sessionId)
				if (!activation.ok || !loaded.ok) throw new Error('Session unavailable')
				const writing = created.callPluginMethod('held-file.write', {})
				await gates.writeEntered.promise
				const closing = created.close()
				await gates.closeEntered.promise
				if (timing !== 'during-close') { gates.releaseClose.resolve(); await closing }
				if (timing === 'after-revoke') host.sessionManager.revokeSession(activation.value)
				const parking = host.sessionManager.parkSession(activation.value)
				await expect(parking).rejects.toBeInstanceOf(SessionRuntimeUnavailableError)
				gates.releaseClose.resolve()
				await closing
				expect(host.sessionManager.parkSession(activation.value)).toBe(parking)
				await expect(host.sessionManager.parkSession(activation.value)).rejects.toBeInstanceOf(SessionRuntimeUnavailableError)
				expect(await host.sessionManager.getSession(created.sessionId)).toMatchObject({ ok: false, error: { type: 'session_runtime_unavailable' } })
				if (timing === 'after-close') {
					gates.releaseWrite.resolve()
					await writing
					expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(false)
					await expect(host.sessionManager.parkSession(activation.value)).rejects.toBeInstanceOf(SessionRuntimeUnavailableError)
				}
				host.sessionManager.revokeSession(activation.value)
				host.sessionManager.revokeSession(activation.value)
				await loaded.value.waitForLocalCleanup()
				if (timing !== 'after-close') expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(false)
				await expect(host.sessionManager.parkSession(activation.value)).rejects.toBeInstanceOf(SessionRuntimeUnavailableError)
				gates.releaseWrite.resolve()
				await writing
				expect(gates.counts()).toEqual({ contexts: 1, closes: 1 })
				expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(true)
				const fresh = await host.sessionManager.getSession(created.sessionId)
				if (!fresh.ok) throw new Error(fresh.error.message)
				expect(fresh.value).not.toBe(loaded.value)
				await expect(host.sessionManager.parkSession(activation.value)).rejects.toBeInstanceOf(SessionRuntimeUnavailableError)
			} finally {
				gates.releaseWrite.resolve()
				gates.releaseClose.resolve()
				await host.shutdown()
			}
		})
	}

	it('parks an already disposed runtime with no remaining resources', async () => {
		const host = harness()
		try {
			const created = await host.createSession('test')
			const activation = host.sessionManager.activateSession(created.sessionId)
			if (!activation.ok) throw new Error(activation.error.message)
			await created.close()
			await host.sessionManager.parkSession(activation.value)
			await host.sessionManager.parkSession(activation.value)
			expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(true)
		} finally { await host.shutdown() }
	})

	it('refuses a wake during idle unload and delivers it after fresh acquisition', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		let deliveries = 0
		const plugin = definePlugin('idle-wake').method('deliver', {
			input: z.object({}), output: z.object({}),
			handler: async () => { deliveries++; return Ok({}) },
		}).sessionHook('onSessionClose', async () => {
			entered.resolve()
			await release.promise
		}).build()
		const host = new TestHarness({ presets: [createTestPreset()], systemPlugins: [plugin], sessionIdleTimeoutMs: 1 })
		const created = await host.createSession('test')
		const key = pluginWakeKey(created.sessionId, 'idle-wake', 'deliver')
		await entered.promise
		try {
			await expect(host.sessionManager.dispatchWake(key)).rejects.toBeInstanceOf(SessionRuntimeUnavailableError)
			expect(deliveries).toBe(0)
		} finally { release.resolve() }
		const loaded = await host.sessionManager.getSession(created.sessionId)
		if (!loaded.ok) throw new Error(loaded.error.message)
		const lease = loaded.value.tryAcquireRuntimeLease('test-delivery')
		if (!lease) throw new Error('Fresh runtime unavailable')
		try {
			await host.sessionManager.dispatchWake(key)
			expect(deliveries).toBe(1)
		} finally { lease(); await host.shutdown() }
	})

	it('requires fresh manager acquisition after close, including during teardown and after reopen', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const plugin = definePlugin('close-boundary').sessionHook('onSessionClose', async () => {
			entered.resolve()
			await release.promise
		}).build()
		const host = harness([plugin])
		const created = await host.createSession('test')
		const loaded = await host.sessionManager.getSession(created.sessionId)
		if (!loaded.ok) throw new Error(loaded.error.message)
		const old = loaded.value
		const closing = old.close()
		await entered.promise
		const assertStale = async () => {
			for (const result of [await old.close(), await old.reopen(), await old.callPluginMethod('sessions.reopen', {}), await old.callPluginMethod('sessions.get', {})]) {
				expect(result).toMatchObject({ ok: false, error: { type: 'session_runtime_unavailable' } })
			}
		}
		await assertStale()
		release.resolve()
		expect((await closing).ok).toBe(true)
		await assertStale()
		const fresh = await host.sessionManager.getSession(created.sessionId)
		if (!fresh.ok) throw new Error(fresh.error.message)
		expect(fresh.value).not.toBe(old)
		expect(await fresh.value.close()).toMatchObject({ ok: false, error: { type: 'session_closed' } })
		expect(await fresh.value.callPluginMethod('sessions.close', {})).toMatchObject({ ok: false, error: { type: 'session_closed' } })
		expect((await fresh.value.reopen()).ok).toBe(true)
		expect(fresh.value.state.status).toBe('active')
		await assertStale()
		expect(old.state.status).toBe('closed')
		expect(await created.getEventsByType(sessionEvents, 'session_reopened')).toHaveLength(1)
		await host.shutdown()
	})

	it('does not label an already running domain-close teardown as graceful parking', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const plugin = definePlugin('closing-before-park').sessionHook('onSessionClose', async () => {
			entered.resolve()
			await release.promise
		}).build()
		const host = harness([plugin])
		const created = await host.createSession('test')
		const activation = host.sessionManager.activateSession(created.sessionId)
		if (!activation.ok) throw new Error(activation.error.message)
		const closing = created.close()
		await entered.promise
		await expect(host.sessionManager.parkSession(activation.value)).rejects.toBeInstanceOf(SessionRuntimeUnavailableError)
		expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(false)
		release.resolve()
		await closing
		await host.shutdown()
	})

	for (const releaseKind of ['park', 'revoke']) {
		it(`fences an already registered reopen across ${releaseKind} while its append is pending`, async () => {
			const entered = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			class ReopenStore extends MemoryEventStore {
				override async append(id: SessionId, event: DomainEvent): Promise<void> {
					if (event.type === 'session_reopened') { entered.resolve(); await release.promise }
					await super.append(id, event)
				}
			}
			let ready = 0
			const plugin = definePlugin('registered-reopen').sessionHook('onSessionReady', async () => { ready++ }).build()
			const host = new TestHarness({ presets: [createTestPreset()], eventStore: new ReopenStore(), systemPlugins: [plugin] })
			const created = await host.createSession('test')
			await created.close()
			const loaded = await host.sessionManager.getSession(created.sessionId)
			const activation = host.sessionManager.activateSession(created.sessionId)
			if (!loaded.ok || !activation.ok) throw new Error('Session unavailable')
			const reopening = loaded.value.reopen().catch((error: unknown) => error)
			await entered.promise
			const parking = host.sessionManager.parkSession(activation.value).catch((error: unknown) => error)
			if (releaseKind === 'revoke') host.sessionManager.revokeSession(activation.value)
			release.resolve()
			if (releaseKind === 'park') {
				expect(await reopening).toMatchObject({ ok: true })
				expect(await parking).toBeUndefined()
			} else {
				expect(await reopening).toBeInstanceOf(SessionRuntimeDetachedError)
				expect(await parking).toBeInstanceOf(SessionRuntimeUnavailableError)
				await loaded.value.waitForLocalCleanup()
			}
			expect(ready).toBe(1)
			expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(true)
			const replacement = await host.sessionManager.getSession(created.sessionId)
			if (!replacement.ok) throw new Error(replacement.error.message)
			expect(replacement.value.state.status).toBe('active')
			expect(ready).toBe(2)
			expect((await loaded.value.reopen()).ok).toBe(false)
			await host.shutdown()
		})
	}

	it('finishes an admitted reopen during parking without registering or starting a successor on A', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		let ready = 0
		let escaped: (() => Promise<void>) | undefined
		const plugin = definePlugin('reopen-drain').method('reopenLater', {
			input: z.object({}), output: z.object({}),
			handler: async (ctx) => {
				escaped = () => ctx.emitEvent(sessionEvents.create('session_reopened', {}))
				entered.resolve()
				await release.promise
				await escaped()
				return Ok({})
			},
		}).sessionHook('onSessionReady', async () => { ready++ }).build()
		const host = harness([plugin])
		const created = await host.createSession('test')
		await created.close()
		const older = await host.sessionManager.getSession(created.sessionId)
		const loaded = await host.sessionManager.getSession(created.sessionId)
		const activation = host.sessionManager.activateSession(created.sessionId)
		if (!loaded.ok || !activation.ok) throw new Error('Session unavailable')
		const reopening = loaded.value.callPluginMethod('reopen-drain.reopenLater', {})
		await entered.promise
		const parking = host.sessionManager.parkSession(activation.value)
		release.resolve()
		expect((await reopening).ok).toBe(true)
		await parking
		if (!older.ok) throw new Error(older.error.message)
		expect((await older.value.reopen()).ok).toBe(false)
		expect(ready).toBe(1)
		expect(loaded.value.state.status).toBe('active')
		expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(true)
		const replacement = await host.sessionManager.getSession(created.sessionId)
		if (!replacement.ok) throw new Error(replacement.error.message)
		expect(ready).toBe(2)
		if (!escaped) throw new Error('Missing escaped reopen')
		await expect(escaped()).rejects.toBeInstanceOf(SessionRuntimeUnavailableError)
		expect((await host.sessionManager.getSession(created.sessionId)).ok).toBe(true)
		await host.shutdown()
	})

	it('cleans a context that finishes initialization after revoke before allowing a successor', async () => {
		const entered = Promise.withResolvers<void>()
		const finishInit = Promise.withResolvers<void>()
		const cleanupEntered = Promise.withResolvers<void>()
		const finishCleanup = Promise.withResolvers<void>()
		const closed: number[] = []
		let contexts = 0
		let ready = 0
		let lateEmit: (() => Promise<void>) | undefined
		const plugin = definePlugin('late-context').context(async (ctx) => {
			const resource = { id: ++contexts }
			if (resource.id === 1) {
				lateEmit = () => ctx.emitEvent(sessionEvents.create('session_overrides_set', {}))
				entered.resolve()
				await finishInit.promise
			}
			return resource
		}).sessionHook('onSessionReady', async () => { ready++ })
			.sessionHook('onSessionClose', async (ctx) => {
				closed.push(ctx.pluginContext.id)
				if (ctx.pluginContext.id === 1) {
					expect(ctx.reason).toBe('revoked')
					cleanupEntered.resolve()
					await finishCleanup.promise
				}
			}).build()
		const host = harness([plugin])
		const id = SessionId('late-context')
		const activation = host.sessionManager.activateSession(id)
		if (!activation.ok) throw new Error(activation.error.message)
		const creating = host.sessionManager.createSession('test', { sessionId: id })
		await entered.promise
		host.sessionManager.revokeSession(activation.value)
		expect(host.sessionManager.activateSession(id).ok).toBe(false)
		finishInit.resolve()
		await cleanupEntered.promise
		expect(ready).toBe(0)
		expect(host.sessionManager.activateSession(id).ok).toBe(false)
		finishCleanup.resolve()
		expect((await creating).ok).toBe(false)
		expect(host.sessionManager.activateSession(id).ok).toBe(true)
		expect((await host.sessionManager.getSession(id)).ok).toBe(true)
		if (!lateEmit) throw new Error('Missing escaped callback')
		await expect(lateEmit()).rejects.toBeInstanceOf(SessionRuntimeUnavailableError)
		expect(closed).toEqual([1])
		expect(ready).toBe(1)
		await host.shutdown()
		expect(closed).toEqual([1, 2])
	})

	for (const termination of ['shutdown', 'close']) {
		it(`${termination} interrupts a pending park instead of reporting graceful success`, async () => {
			const entered = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			const plugin = definePlugin('terminate-park').method('wait', {
				input: z.object({}), output: z.object({}),
				handler: async (ctx) => {
					entered.resolve()
					await release.promise
					if (termination === 'close') await ctx.emitEvent(sessionEvents.create('session_closed', {}))
					return Ok({})
				},
			}).build()
			const host = harness([plugin])
			const created = await host.createSession('test')
			const activation = host.sessionManager.activateSession(created.sessionId)
			if (!activation.ok) throw new Error(activation.error.message)
			const mutation = created.callPluginMethod('terminate-park.wait', {})
			await entered.promise
			const parking = host.sessionManager.parkSession(activation.value).catch((error: unknown) => error)
			if (termination === 'shutdown') await host.sessionManager.shutdown()
			release.resolve()
			expect((await mutation).ok).toBe(true)
			expect(await parking).toBeInstanceOf(SessionRuntimeUnavailableError)
			await host.shutdown()
		})
	}

	it('refuses reconstruction while a revoked tenure still has an issued append', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		class GatedAppend extends MemoryEventStore {
			override async append(id: SessionId, event: DomainEvent): Promise<void> {
				if (event.type === 'session_overrides_set') {
					entered.resolve()
					await release.promise
				}
				await super.append(id, event)
			}
		}
		const host = new TestHarness({ presets: [createTestPreset()], eventStore: new GatedAppend() })
		const created = await host.createSession('test')
		const loaded = await host.sessionManager.getSession(created.sessionId)
		const activation = host.sessionManager.activateSession(created.sessionId)
		if (!loaded.ok || !activation.ok) throw new Error('Session unavailable')
		const mutation = loaded.value.setOverrides({}).catch((error: unknown) => error)
		await entered.promise
		const parking = host.sessionManager.parkSession(activation.value).catch((error: unknown) => error)
		host.sessionManager.revokeSession(activation.value)
		expect(await parking).toBeInstanceOf(SessionRuntimeUnavailableError)
		expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(false)
		expect(loaded.value.store.hasPendingWrites()).toBe(true)
		release.resolve()
		expect(await mutation).toBeInstanceOf(SessionRuntimeDetachedError)
		expect(loaded.value.store.hasPendingWrites()).toBe(false)
		await host.shutdown()
	})

	it('durably creates a child requested by an admitted continuation without starting it on A', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const started = Promise.withResolvers<string>()
		const starts: string[] = []
		const plugin = definePlugin('child-handoff').dependencies([agentsPlugin])
			.method('spawnLater', {
				input: z.object({ parentId: agentIdSchema }), output: z.object({ agentId: agentIdSchema }),
				handler: async (ctx, input) => {
					entered.resolve()
					await release.promise
					return ctx.deps.agents.spawn({ definitionName: 'child', parentId: input.parentId, message: 'work' })
				},
			})
			.hook('onStart', async (ctx) => {
				if (ctx.agentState.definitionName === 'child') {
					starts.push(ctx.agentId)
					started.resolve(ctx.agentId)
				}
				return null
			}).build()
		const host = new TestHarness({
			presets: [createTestPreset({ agents: [{ name: 'child', system: 'Finish the task', tools: [], agents: [] }] })],
			systemPlugins: [plugin],
		})
		const created = await host.createSession('test')
		const activation = host.sessionManager.activateSession(created.sessionId)
		if (!activation.ok) throw new Error(activation.error.message)
		const spawn = created.callPluginMethod('child-handoff.spawnLater', { parentId: created.getEntryAgentId() })
		await entered.promise
		const parking = host.sessionManager.parkSession(activation.value)
		release.resolve()
		const result = await spawn
		if (!result.ok) throw new Error(result.error.message)
		const child = z.object({ agentId: agentIdSchema }).parse(result.value)
		await parking
		expect(starts).toEqual([])
		expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(true)
		expect((await host.sessionManager.getSession(created.sessionId)).ok).toBe(true)
		expect(await started.promise).toBe(child.agentId)
		await host.shutdown()
	})

	it('authenticates handles, leaves absent sessions unloaded and retains release tombstones', async () => {
		const host = harness()
		const foreign = harness()
		const id = SessionId('not-loaded')
		const activation = host.sessionManager.activateSession(id)
		if (!activation.ok) throw new Error(activation.error.message)
		expect(host.sessionManager.activateSession(id)).toEqual(activation)
		expect(host.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
		await expect(host.sessionManager.parkSession({ sessionId: id })).rejects.toBeInstanceOf(SessionRuntimeUnavailableError)
		await expect(foreign.sessionManager.parkSession(activation.value)).rejects.toBeInstanceOf(SessionRuntimeUnavailableError)
		await host.sessionManager.parkSession(activation.value)
		const unavailable = await host.sessionManager.getSession(id)
		expect(unavailable.ok).toBe(false)
		if (!unavailable.ok) expect(unavailable.error.type).toBe('session_runtime_unavailable')
		const replacement = host.sessionManager.activateSession(id)
		if (!replacement.ok) throw new Error(replacement.error.message)
		expect(replacement.value).not.toBe(activation.value)
		await host.sessionManager.parkSession(activation.value)
		host.sessionManager.revokeSession(activation.value)
		expect(host.sessionManager.activateSession(id)).toEqual(replacement)
		await Promise.all([host.shutdown(), foreign.shutdown()])
	})

	it('drains admitted nested mutations but refuses later external requests', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		let nested = 0
		const plugin = definePlugin('drain')
			.method('inner', {
				input: z.object({}), output: z.object({}),
				handler: async (ctx) => {
					ctx.reserveSequence('drain', () => 1)
					await ctx.emitEvent(sessionEvents.create('session_overrides_set', {}))
					nested++
					return Ok({})
				},
			})
			.sessionHook('beforeMethod', async (ctx) => {
				if (ctx.method !== 'drain.outer') return null
				entered.resolve()
				await release.promise
				await ctx.self.inner({})
				return null
			})
			.method('outer', {
				input: z.object({}), output: z.object({}),
				handler: async () => Ok({}),
			})
			.build()
		const host = harness([plugin])
		const testSession = await host.createSession('test')
		const activation = host.sessionManager.activateSession(testSession.sessionId)
		const loaded = await host.sessionManager.getSession(testSession.sessionId)
		if (!activation.ok || !loaded.ok) throw new Error('Session unavailable')
		const mutation = loaded.value.callPluginMethod('drain.outer', {})
		await entered.promise
		let parked = false
		const parking = host.sessionManager.parkSession(activation.value).then(() => { parked = true })
		expect((await loaded.value.setOverrides({})).ok).toBe(false)
		expect((await loaded.value.callPluginMethod('drain.inner', {})).ok).toBe(false)
		expect(parked).toBe(false)
		expect(host.sessionManager.activateSession(testSession.sessionId).ok).toBe(false)
		release.resolve()
		expect((await mutation).ok).toBe(true)
		await parking
		expect(nested).toBe(1)
		expect(loaded.value.store.isDetached()).toBe(true)
		expect(host.sessionManager.activateSession(testSession.sessionId).ok).toBe(true)
		const replacement = await host.sessionManager.getSession(testSession.sessionId)
		if (!replacement.ok) throw new Error(replacement.error.message)
		expect(replacement.value).not.toBe(loaded.value)
		expect((await host.eventStore.load(testSession.sessionId)).some((event) => event.type === 'session_closed')).toBe(false)
		await host.shutdown()
	})

	it('revoke rejects pending park without waiting for a hung method', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const plugin = definePlugin('hung')
			.method('run', {
				input: z.object({}), output: z.object({}),
				handler: async (ctx) => {
					entered.resolve()
					await release.promise
					await ctx.emitEvent(sessionEvents.create('session_overrides_set', {}))
					return Ok({})
				},
			}).build()
		const host = harness([plugin])
		const testSession = await host.createSession('test')
		const activation = host.sessionManager.activateSession(testSession.sessionId)
		const loaded = await host.sessionManager.getSession(testSession.sessionId)
		if (!activation.ok || !loaded.ok) throw new Error('Session unavailable')
		const mutation = loaded.value.callPluginMethod('hung.run', {}).catch((error: unknown) => error)
		await entered.promise
		const parking = host.sessionManager.parkSession(activation.value).catch((error: unknown) => error)
		host.sessionManager.revokeSession(activation.value)
		expect(await parking).toBeInstanceOf(SessionRuntimeUnavailableError)
		await loaded.value.waitForLocalCleanup()
		expect(host.sessionManager.activateSession(testSession.sessionId).ok).toBe(true)
		release.resolve()
		expect(await mutation).toBeInstanceOf(SessionRuntimeUnavailableError)
		expect(host.sessionManager.activateSession(testSession.sessionId).ok).toBe(true)
		await host.shutdown()
	})

	it('keeps a revoked load on its original tenure and blocks overlap until it settles', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		class GatedLoad extends MemoryEventStore {
			gated = false
			override async load(id: SessionId): Promise<DomainEvent[]> {
				if (this.gated) {
					entered.resolve()
					await release.promise
				}
				return super.load(id)
			}
		}
		const storage = new GatedLoad()
		let readyHooks = 0
		const plugin = definePlugin('load-hook').sessionHook('onSessionReady', async () => { readyHooks++ }).build()
		const host = new TestHarness({ presets: [createTestPreset()], eventStore: storage, systemPlugins: [plugin] })
		const created = await host.createSession('test')
		const first = host.sessionManager.activateSession(created.sessionId)
		if (!first.ok) throw new Error(first.error.message)
		await host.sessionManager.parkSession(first.value)
		const second = host.sessionManager.activateSession(created.sessionId)
		if (!second.ok) throw new Error(second.error.message)
		storage.gated = true
		const loading = host.sessionManager.getSession(created.sessionId)
		await entered.promise
		host.sessionManager.revokeSession(second.value)
		expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(false)
		release.resolve()
		const refused = await loading
		expect(refused.ok).toBe(false)
		if (!refused.ok) expect(refused.error.type).toBe('session_runtime_unavailable')
		expect(readyHooks).toBe(1)
		expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(true)
		await host.shutdown()
	})

	it('fails closed on hook errors while attempting every close hook', async () => {
		const called: string[] = []
		const first = definePlugin('first').sessionHook('onSessionClose', async (ctx) => {
			called.push(`first:${ctx.reason}`)
		}).build()
		const last = definePlugin('last').sessionHook('onSessionClose', async (ctx) => {
			called.push(`last:${ctx.reason}`)
			if (ctx.reason === 'parked') throw new Error('close failed')
		}).build()
		const host = harness([first, last])
		const created = await host.createSession('test')
		const activation = host.sessionManager.activateSession(created.sessionId)
		if (!activation.ok) throw new Error(activation.error.message)
		await expect(host.sessionManager.parkSession(activation.value)).rejects.toBeInstanceOf(AggregateError)
		expect(called).toEqual(['last:parked', 'first:parked'])
		expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(false)
		host.sessionManager.revokeSession(activation.value)
		await host.shutdown()
	})
})
