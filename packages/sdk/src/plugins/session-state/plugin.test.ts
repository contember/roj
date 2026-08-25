import { describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import z from 'zod/v4'
import { FileEventStore } from '~/core/events/file.js'
import { MemoryEventStore } from '~/core/events/memory.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { DomainEvent } from '~/core/events/types.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { createSessionState } from '~/core/sessions/state.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import {
	DEFAULT_SESSION_STATE_MAX_BYTES,
	sessionStateEvents,
	sessionStatePlugin,
	type SessionStatePluginConfig,
} from './plugin.js'

interface TestSessionState {
	state: Record<string, unknown>
	pendingExternalUpdates: Map<string, number>
	nextExternalRevision: number
	initialized: boolean
}

class GatedPatchEventStore extends MemoryEventStore {
	private patchCount = 0
	private releaseFirstPatch = () => {}
	private markFirstPatchStarted = () => {}
	readonly firstPatchStarted = new Promise<void>((resolve) => {
		this.markFirstPatchStarted = resolve
	})

	release(): void {
		this.releaseFirstPatch()
	}

	override async append(sessionId: SessionId, event: DomainEvent): Promise<void> {
		if (event.type === 'session_state_patched' && ++this.patchCount === 1) {
			this.markFirstPatchStarted()
			await new Promise<void>((resolve) => {
				this.releaseFirstPatch = resolve
			})
		}
		await super.append(sessionId, event)
	}
}

const waitForMacrotaskTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

function createHarness(
	config: SessionStatePluginConfig,
	eventStore?: MemoryEventStore,
	llmProvider = MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
) {
	const preset = createTestPreset({
		plugins: [sessionStatePlugin.configure(config)],
	})
	return new TestHarness({
		presets: [preset],
		systemPlugins: [sessionStatePlugin],
		eventStore,
		llmProvider,
	})
}

async function updateState(
	session: Awaited<ReturnType<TestHarness['createSession']>>,
	updates: Record<string, unknown>,
) {
	return session.callPluginMethod('sessionState.update', {
		sessionId: String(session.sessionId),
		updates,
	})
}

describe('session state plugin', () => {
	it('replays legacy snapshots and new patches in order', async () => {
		const config: SessionStatePluginConfig = {
			schema: z.object({ a: z.number(), b: z.number() }),
			initial: { a: 0, b: 0 },
		}
		const firstHarness = createHarness(config)
		const firstSession = await firstHarness.createSession('test')
		const sessionId = firstSession.sessionId
		await firstHarness.shutdown()

		await firstHarness.eventStore.append(sessionId, withSessionId(sessionId, sessionStateEvents.create('session_state_updated', {
			state: { a: 1, b: 2 },
			callerSource: 'agent',
		})))

		const secondHarness = createHarness(config, firstHarness.eventStore)
		const secondSession = await secondHarness.openSession(sessionId)
		const result = await updateState(secondSession, { b: 3 })
		expect(result.ok).toBe(true)
		expect(secondSession.getPluginState<TestSessionState>('sessionState')?.state).toEqual({ a: 1, b: 3 })

		const patches = await secondSession.getEventsByType(sessionStateEvents, 'session_state_patched')
		expect(patches).toHaveLength(1)
		expect(patches[0].set).toEqual({ b: 3 })
		expect(patches[0].deletedKeys).toEqual([])
		await secondHarness.shutdown()
	})

	it('accepts an exact byte limit and rejects one byte over without side effects', async () => {
		const exactState = { value: 'abc' }
		const exactBytes = new TextEncoder().encode(JSON.stringify(exactState)).byteLength
		const harness = createHarness({
			schema: z.object({ value: z.string() }),
			initial: { value: '' },
			maxSerializedBytes: exactBytes,
		})
		const session = await harness.createSession('test')
		const agentId = session.getEntryAgentId()
		if (!agentId) throw new Error('Expected entry agent')
		await session.pauseAgent(agentId)

		const accepted = await updateState(session, { value: 'abc' })
		expect(accepted.ok).toBe(true)
		const eventCount = (await session.getEvents()).length
		const notificationCount = session.getNotifications().length

		const rejected = await updateState(session, { value: 'abcd' })
		expect(rejected.ok).toBe(false)
		expect((await session.getEvents()).length).toBe(eventCount)
		expect(session.getNotifications()).toHaveLength(notificationCount)
		expect(session.getPluginState<TestSessionState>('sessionState')?.state).toEqual(exactState)
		await harness.shutdown()
	})

	it('counts multibyte state as UTF-8 bytes', async () => {
		const multibyteState = { value: 'ž' }
		const byteLength = new TextEncoder().encode(JSON.stringify(multibyteState)).byteLength
		const harness = createHarness({
			schema: z.object({ value: z.string() }),
			initial: { value: '' },
			maxSerializedBytes: byteLength - 1,
		})
		const session = await harness.createSession('test')
		const result = await updateState(session, multibyteState)
		expect(result.ok).toBe(false)
		expect(await session.getEventsByType(sessionStateEvents, 'session_state_patched')).toHaveLength(0)
		await harness.shutdown()
	})

	it('persists schema-transformed output as a compact cumulative patch', async () => {
		const harness = createHarness({
			schema: z.object({ name: z.string().trim(), count: z.number() }),
			initial: { name: '', count: 0 },
		})
		const session = await harness.createSession('test')
		const first = await updateState(session, { name: '  Alice  ' })
		const second = await updateState(session, { count: 2 })
		expect(first.ok).toBe(true)
		expect(second.ok).toBe(true)
		expect(session.getPluginState<TestSessionState>('sessionState')?.state).toEqual({ name: 'Alice', count: 2 })

		const patches = await session.getEventsByType(sessionStateEvents, 'session_state_patched')
		expect(patches.map((event) => event.set)).toEqual([{ name: 'Alice' }, { count: 2 }])
		await harness.shutdown()
	})

	it('rejects an oversized initial state before the session becomes ready', async () => {
		const harness = createHarness({
			schema: z.object({ value: z.string() }),
			initial: { value: 'large' },
			maxSerializedBytes: 1,
		})
		await expect(harness.createSession('test')).rejects.toThrow('Invalid initial session state')
		await harness.shutdown()
	})

	it('tracks changed external keys without duplicating the current full state', async () => {
		const harness = createHarness({
			schema: z.object({ a: z.number(), b: z.number() }),
			initial: { a: 0, b: 0 },
			maxSerializedBytes: DEFAULT_SESSION_STATE_MAX_BYTES,
		})
		const session = await harness.createSession('test')
		const agentId = session.getEntryAgentId()
		if (!agentId) throw new Error('Expected entry agent')
		await session.pauseAgent(agentId)

		await updateState(session, { a: 1 })
		await updateState(session, { b: 2 })
		const state = session.getPluginState<TestSessionState>('sessionState')
		expect([...state?.pendingExternalUpdates.keys() ?? []].sort()).toEqual(['a', 'b'])
		expect(state?.state).toEqual({ a: 1, b: 2 })

		const serializedEvents = JSON.stringify(await session.getEventsByType(sessionStateEvents, 'session_state_patched'))
		expect(serializedEvents).not.toContain('"a":1,"b":2')
		await harness.shutdown()
	})

	it('does not consume a newer update to a key delivered by an earlier turn', async () => {
		let releaseFirst = () => {}
		let releaseSecond = () => {}
		let markFirstStarted = () => {}
		let markSecondStarted = () => {}
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve
		})
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve
		})
		const secondStarted = new Promise<void>((resolve) => {
			markSecondStarted = resolve
		})
		let callCount = 0
		const llmProvider = new MockLLMProvider(async () => {
			callCount++
			if (callCount === 1) {
				markFirstStarted()
				await firstGate
			} else if (callCount === 2) {
				markSecondStarted()
				await secondGate
			}
			return {
				content: 'Ok',
				toolCalls: [],
				finishReason: 'stop',
				metrics: MockLLMProvider.defaultMetrics(),
			}
		})
		const harness = createHarness({
			schema: z.object({ value: z.number() }),
			initial: { value: 0 },
		}, undefined, llmProvider)
		const session = await harness.createSession('test')

		await updateState(session, { value: 1 })
		await firstStarted
		await updateState(session, { value: 2 })
		releaseFirst()
		await secondStarted

		const duringSecondTurn = session.getPluginState<TestSessionState>('sessionState')
		expect(duringSecondTurn?.pendingExternalUpdates.has('value')).toBe(true)
		const secondRequest = llmProvider.getCallHistory()[1]
		const prompt = secondRequest.messages.map((message) => JSON.stringify(message.content)).join('\n')
		expect(prompt).toContain('Changed keys: value')
		expect(prompt).not.toContain('"value":2')

		releaseSecond()
		await session.waitForIdle()
		expect(session.getPluginState<TestSessionState>('sessionState')?.pendingExternalUpdates.size).toBe(0)
		await harness.shutdown()
	})

	it('serializes concurrent updates and revisions them in commit order', async () => {
		const eventStore = new GatedPatchEventStore()
		const harness = createHarness({
			schema: z.object({ value: z.number() }),
			initial: { value: 0 },
		}, eventStore)
		const session = await harness.createSession('test')
		const agentId = session.getEntryAgentId()
		if (!agentId) throw new Error('Expected entry agent')
		await session.pauseAgent(agentId)

		const firstUpdate = updateState(session, { value: 1 })
		await eventStore.firstPatchStarted
		let secondSettled = false
		const secondUpdate = updateState(session, { value: 2 }).then((result) => {
			secondSettled = true
			return result
		})
		// The second update must not overtake the first: it is validated and
		// appended only once the first one is committed.
		await waitForMacrotaskTurn()
		expect(secondSettled).toBe(false)

		eventStore.release()
		await firstUpdate
		await secondUpdate

		const patches = await session.getEventsByType(sessionStateEvents, 'session_state_patched')
		expect(patches.map((event) => event.externalRevision)).toEqual([1, 2])
		expect(session.getPluginState<TestSessionState>('sessionState')?.state).toEqual({ value: 2 })
		const pending = session.getPluginState<TestSessionState>('sessionState')?.pendingExternalUpdates
		expect(pending?.get('value')).toBe(2)

		await session.resumeAgent(agentId)
		await session.waitForIdle()
		expect(session.getPluginState<TestSessionState>('sessionState')?.pendingExternalUpdates.size).toBe(0)
		await harness.shutdown()
	})

	it('rejects a queued update that would merge past the byte limit', async () => {
		const filler = 'x'.repeat(50)
		// Fits one key, not two: without serialization both updates validate against
		// the same empty base, and the merged state lands over the limit.
		const maxSerializedBytes = new TextEncoder().encode(JSON.stringify({ a: filler })).byteLength
		const eventStore = new GatedPatchEventStore()
		const harness = createHarness({
			schema: z.object({ a: z.string().optional(), b: z.string().optional() }),
			initial: {},
			maxSerializedBytes,
		}, eventStore)
		const session = await harness.createSession('test')
		const agentId = session.getEntryAgentId()
		if (!agentId) throw new Error('Expected entry agent')
		await session.pauseAgent(agentId)

		const firstUpdate = updateState(session, { a: filler })
		await eventStore.firstPatchStarted
		const secondUpdate = updateState(session, { b: filler })
		eventStore.release()

		expect((await firstUpdate).ok).toBe(true)
		const second = await secondUpdate
		expect(second.ok).toBe(false)
		expect(await session.getEventsByType(sessionStateEvents, 'session_state_patched')).toHaveLength(1)
		expect(session.getPluginState<TestSessionState>('sessionState')?.state).toEqual({ a: filler })
		await harness.shutdown()
	})

	it('stores and deletes __proto__ as an own state key without prototype mutation', async () => {
		const schema = z.object({
			protoValue: z.unknown().optional(),
			removeProto: z.boolean().optional(),
			safe: z.number().optional(),
		}).transform((value) => {
			const entries: Array<[string, unknown]> = []
			if (value.safe !== undefined) entries.push(['safe', value.safe])
			if (!value.removeProto && value.protoValue !== undefined) entries.push(['__proto__', value.protoValue])
			return Object.fromEntries(entries)
		})
		const config: SessionStatePluginConfig = { schema, initial: {} }
		const harness = createHarness(config)
		const session = await harness.createSession('test')
		const protoValue = { polluted: true }

		const setResult = await updateState(session, { protoValue, safe: 1 })
		expect(setResult.ok).toBe(true)
		const setState = session.getPluginState<TestSessionState>('sessionState')?.state
		expect(Object.hasOwn(setState ?? {}, '__proto__')).toBe(true)
		expect(setState?.__proto__).toEqual(protoValue)
		expect(Object.getPrototypeOf(setState)).toBe(Object.prototype)

		const deleteResult = await updateState(session, { removeProto: true })
		expect(deleteResult.ok).toBe(true)
		const deleteState = session.getPluginState<TestSessionState>('sessionState')?.state
		expect(Object.hasOwn(deleteState ?? {}, '__proto__')).toBe(false)
		expect(Object.getPrototypeOf(deleteState)).toBe(Object.prototype)
		const patches = await session.getEventsByType(sessionStateEvents, 'session_state_patched')
		expect(patches[0].set).toHaveProperty('__proto__', protoValue)
		expect(patches[1].deletedKeys).toContain('__proto__')
		const sessionId = session.sessionId
		await harness.shutdown()

		const replayHarness = createHarness(config, harness.eventStore)
		const replaySession = await replayHarness.openSession(sessionId)
		const replayState = replaySession.getPluginState<TestSessionState>('sessionState')?.state
		expect(replayState).toEqual({ safe: 1 })
		expect(Object.getPrototypeOf(replayState)).toBe(Object.prototype)
		await replayHarness.shutdown()
	})

	it('canonicalizes Date output and replays the same state through FileEventStore', async () => {
		const initialDate = new Date('2026-01-01T00:00:00.000Z')
		const updatedDate = new Date('2026-02-01T00:00:00.000Z')
		const config: SessionStatePluginConfig = {
			schema: z.object({ when: z.coerce.date() }),
			initial: { when: initialDate },
		}
		const harness = createHarness(config)
		const session = await harness.createSession('test')
		await updateState(session, { when: updatedDate.toISOString() })
		const liveState = session.getPluginState<TestSessionState>('sessionState')?.state
		expect(liveState).toEqual({ when: updatedDate.toISOString() })
		const patch = (await session.getEventsByType(sessionStateEvents, 'session_state_patched'))[0]
		expect(patch.set).toEqual({ when: updatedDate.toISOString() })

		const basePath = `/tmp/roj-session-state-file-${Math.random().toString(36).slice(2)}`
		try {
			const fileStore = new FileEventStore(basePath, createNodeFileSystem())
			await fileStore.append(session.sessionId, patch)
			const loaded = await fileStore.load(session.sessionId)
			const configured = sessionStatePlugin.create(config)
			const initial = createSessionState(session.sessionId, 'test', 0)
			const replayed = loaded.reduce((state, event) => configured.slice?.reducer(state, event) ?? state, initial)
			expect(configured.slice?.select(replayed)).toEqual({
				state: { when: updatedDate.toISOString() },
				pendingExternalUpdates: new Map([['when', 1]]),
				nextExternalRevision: 1,
				initialized: true,
			})
		} finally {
			await rm(basePath, { recursive: true, force: true })
			await harness.shutdown()
		}
	})

	it('rejects unsupported and cyclic JSON values without side effects', async () => {
		const harness = createHarness({ schema: z.record(z.string(), z.unknown()), initial: {} })
		const session = await harness.createSession('test')
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		const eventCount = (await session.getEvents()).length
		const notificationCount = session.getNotifications().length

		for (const value of [undefined, () => 'unsupported', cyclic]) {
			const result = await updateState(session, { value })
			expect(result.ok).toBe(false)
		}
		expect(await session.getEvents()).toHaveLength(eventCount)
		expect(session.getNotifications()).toHaveLength(notificationCount)
		expect(session.getPluginState<TestSessionState>('sessionState')?.state).toEqual({})
		await harness.shutdown()
	})
})
