import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { createWorkerDefinition } from './definition.js'
import { MAX_CONCURRENT_WORKERS, workerPlugin } from './plugin.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { Ok } from '~/lib/utils/result.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import type { WorkerEntry, WorkerId } from './worker.js'

describe('worker handoff', () => {
	it('stops an abort-dependent worker on the park deadline and resumes it on replacement', async () => {
		const entered = Promise.withResolvers<void>()
		const resumed = Promise.withResolvers<void>()
		let aborts = 0
		const worker = createWorkerDefinition('until-abort', 'Run until stopped', z.object({}), {
			initialState: () => ({}), reduce: (state: {}) => state,
			execute: async (_config, ctx) => {
				if (ctx.resumed) resumed.resolve()
				entered.resolve()
				await new Promise<void>((resolve) => ctx.getAbortSignal().addEventListener('abort', () => {
					aborts++
					resolve()
				}, { once: true }))
				return Ok({ status: 'done', summary: 'stopped' })
			},
		})
		const host = new TestHarness({ presets: [createTestPreset({
			plugins: [workerPlugin.configure({ workers: [worker], stopTimeoutMs: 10, effectDrainTimeoutMs: 10 })],
		})] })
		try {
			const created = await host.createSession('test')
			const activation = host.sessionManager.activateSession(created.sessionId)
			if (!activation.ok) throw new Error(activation.error.message)
			expect((await created.callPluginMethod('workers.spawn', {
				sessionId: created.sessionId, agentId: created.getEntryAgentId(), workerType: 'until-abort', config: {},
			})).ok).toBe(true)
			await entered.promise
			await host.sessionManager.parkSession(activation.value, { timeoutMs: 1000 })
			expect(aborts).toBe(1)
			expect((await host.eventStore.load(created.sessionId)).filter((event) => event.type === 'worker_completed')).toHaveLength(0)
			expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(true)
			expect((await host.sessionManager.getSession(created.sessionId)).ok).toBe(true)
			await resumed.promise
		} finally { await host.shutdown() }
	})

	it('manually starts a restored overflow worker for the first time, then resumes its interrupted execution', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const restored = Promise.withResolvers<void>()
		const firstOverflow = Promise.withResolvers<void>()
		const resumedOverflow = Promise.withResolvers<void>()
		const runs = new Map<number, boolean[]>()
		let admissions = 0
		const worker = createWorkerDefinition('overflow', 'Pending first runs', z.object({ index: z.number() }), {
			initialState: () => ({}), reduce: (state: {}) => state,
			execute: async (config, ctx) => {
				const history = runs.get(config.index) ?? []
				history.push(ctx.resumed)
				runs.set(config.index, history)
				if (runs.size === MAX_CONCURRENT_WORKERS) restored.resolve()
				if (config.index === MAX_CONCURRENT_WORKERS) {
					if (ctx.resumed) resumedOverflow.resolve()
					else firstOverflow.resolve()
				}
				await new Promise<void>((resolve) => ctx.getAbortSignal().addEventListener('abort', () => resolve(), { once: true }))
				return Ok({ status: 'done', summary: 'interrupted' })
			},
		})
		const gate = definePlugin('overflow-gate').sessionHook('beforeMethod', async (ctx) => {
			if (ctx.method !== 'workers.spawn') return null
			if (++admissions === MAX_CONCURRENT_WORKERS + 1) entered.resolve()
			await release.promise
			return null
		}).build()
		const host = new TestHarness({
			presets: [createTestPreset({ plugins: [workerPlugin.configure({ workers: [worker] })] })], systemPlugins: [workerPlugin, gate],
		})
		try {
			const created = await host.createSession('test')
			const agentId = created.getEntryAgentId()
			const activation = host.sessionManager.activateSession(created.sessionId)
			if (!agentId || !activation.ok) throw new Error('Session unavailable')
			const spawning = Array.from({ length: MAX_CONCURRENT_WORKERS + 1 }, (_, index) => created.callPluginMethod('workers.spawn', {
				sessionId: created.sessionId, agentId, workerType: 'overflow', config: { index },
			}))
			await entered.promise
			const parking = host.sessionManager.parkSession(activation.value)
			release.resolve()
			for (const result of await Promise.all(spawning)) expect(result.ok).toBe(true)
			await parking
			expect(runs.size).toBe(0)
			expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(true)
			const loaded = await host.sessionManager.getSession(created.sessionId)
			if (!loaded.ok) throw new Error(loaded.error.message)
			await restored.promise
			const workers = selectPluginState<Map<WorkerId, WorkerEntry>>(loaded.value.state, 'workers')
			if (!workers) throw new Error('Missing workers')
			const overflow = [...workers.values()].find((entry) => entry.pendingStart)
			const running = [...workers.values()].find((entry) => entry.status === 'running')
			if (!overflow || !running) throw new Error('Missing overflow or running worker')
			expect(overflow.status).toBe('paused')
			expect(runs.has(MAX_CONCURRENT_WORKERS)).toBe(false)
			expect((await loaded.value.callPluginMethod('workers.pause', { sessionId: created.sessionId, agentId, workerId: running.id })).ok).toBe(true)
			expect((await loaded.value.callPluginMethod('workers.resume', { sessionId: created.sessionId, agentId, workerId: overflow.id })).ok).toBe(true)
			await firstOverflow.promise
			expect(runs.get(MAX_CONCURRENT_WORKERS)).toEqual([false])
			expect(selectPluginState<Map<WorkerId, WorkerEntry>>(loaded.value.state, 'workers')?.get(overflow.id)?.pendingStart).toBe(false)
			expect((await loaded.value.callPluginMethod('workers.pause', { sessionId: created.sessionId, agentId, workerId: overflow.id })).ok).toBe(true)
			expect((await loaded.value.callPluginMethod('workers.resume', { sessionId: created.sessionId, agentId, workerId: overflow.id })).ok).toBe(true)
			await resumedOverflow.promise
			expect(runs.get(MAX_CONCURRENT_WORKERS)).toEqual([false, true])
		} finally { release.resolve(); await host.shutdown() }
	})

	it('waits for an admitted worker and its terminal event without aborting it', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		let aborted = false
		const worker = createWorkerDefinition('drain', 'Finish during park', z.object({}), {
			initialState: () => ({}), reduce: (state: {}) => state,
			execute: async (_config, ctx) => {
				ctx.getAbortSignal().addEventListener('abort', () => { aborted = true })
				entered.resolve()
				await release.promise
				await ctx.emit({ type: 'finished' })
				await ctx.notifyAgent('finished')
				return Ok({ status: 'done', summary: 'done' })
			},
		})
		const host = new TestHarness({ presets: [createTestPreset({ plugins: [workerPlugin.configure({ workers: [worker] })] })] })
		const created = await host.createSession('test')
		const activation = host.sessionManager.activateSession(created.sessionId)
		if (!activation.ok) throw new Error(activation.error.message)
		expect((await created.callPluginMethod('workers.spawn', {
			sessionId: created.sessionId, agentId: created.getEntryAgentId(), workerType: 'drain', config: {},
		})).ok).toBe(true)
		await entered.promise
		let parked = false
		const parking = host.sessionManager.parkSession(activation.value).then(() => { parked = true })
		expect(parked).toBe(false)
		expect(aborted).toBe(false)
		release.resolve()
		await parking
		expect(aborted).toBe(false)
		const events = await host.eventStore.load(created.sessionId)
		expect(events.filter((event) => event.type === 'worker_completed')).toHaveLength(1)
		expect(events.filter((event) => event.type === 'worker_sub_event')).toHaveLength(1)
		expect(events.filter((event) => event.type === 'mailbox_message')).toHaveLength(1)
		await host.shutdown()
	})

	it('persists a launch admitted during drain and first executes it on B without resumed=true', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const executed = Promise.withResolvers<void>()
		const resumed: boolean[] = []
		const worker = createWorkerDefinition('handoff', 'Record first execution', z.object({}), {
			initialState: () => ({}), reduce: (state: {}) => state,
			execute: async (_config, ctx) => {
				resumed.push(ctx.resumed)
				executed.resolve()
				return Ok({ status: 'done', summary: 'done' })
			},
		})
		const gate = definePlugin('launch-gate').sessionHook('beforeMethod', async (ctx) => {
			if (ctx.method !== 'workers.spawn') return null
			entered.resolve()
			await release.promise
			return null
		}).build()
		const host = new TestHarness({
			presets: [createTestPreset({ plugins: [workerPlugin.configure({ workers: [worker] })] })],
			systemPlugins: [workerPlugin, gate],
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'done', toolCalls: [] }),
		})
		const created = await host.createSession('test')
		const loaded = await host.sessionManager.getSession(created.sessionId)
		const activation = host.sessionManager.activateSession(created.sessionId)
		if (!loaded.ok || !activation.ok) throw new Error('Session unavailable')
		const agent = loaded.value.getEntryAgent()
		if (!agent) throw new Error('Agent missing')
		const spawn = loaded.value.callPluginMethod('workers.spawn', {
			sessionId: created.sessionId, agentId: agent.id, workerType: 'handoff', config: {},
		})
		await entered.promise
		const parking = host.sessionManager.parkSession(activation.value)
		release.resolve()
		expect((await spawn).ok).toBe(true)
		await parking
		expect(resumed).toEqual([])
		const workers = selectPluginState<Map<WorkerId, WorkerEntry>>(loaded.value.state, 'workers')
		expect(workers && [...workers.values()].map((entry) => entry.pendingStart)).toEqual([true])
		expect(host.sessionManager.activateSession(created.sessionId).ok).toBe(true)
		expect((await host.sessionManager.getSession(created.sessionId)).ok).toBe(true)
		await executed.promise
		expect(resumed).toEqual([false])
		await host.shutdown()
	})
})
