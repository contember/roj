import { describe, expect, it } from 'bun:test'
import { ClosedSessionAppendError, EventAppendError, EventAppendOutcomeUnknownError } from '../events/event-store.js'
import { MemoryEventStore } from '../events/memory.js'
import type { DomainEvent } from '../events/types.js'
import { withSessionId } from '../events/test-helpers.js'
import { SessionId } from './schema.js'
import { SessionRuntimeDetachedError, SessionStore } from './session-store.js'
import { createSessionState, sessionEvents } from './state.js'

const id = SessionId('store-ordering')
const event = (timestamp: number) => ({ ...withSessionId(id, sessionEvents.create('session_overrides_set', {})), timestamp })

class DeferredStore extends MemoryEventStore {
	readonly entered = Promise.withResolvers<void>()
	readonly gate = Promise.withResolvers<void>()
	readonly calls: number[] = []
	failure: Error | undefined

	override async append(sessionId: SessionId, value: DomainEvent): Promise<void> {
		this.calls.push(value.timestamp)
		if (this.calls.length === 1) {
			this.entered.resolve()
			await this.gate.promise
			if (this.failure) throw this.failure
		}
		await super.append(sessionId, value)
	}
}

function setup(storage: DeferredStore, options?: { queueTimeoutMs?: number }) {
	const applied: number[] = []
	const notified: number[] = []
	const store = new SessionStore(id, storage, createSessionState(id, 'test', 0), (state, value) => {
		applied.push(value.timestamp)
		return state
	}, options)
	store.onEvent((value) => notified.push(value.timestamp))
	return { store, applied, notified }
}

describe('SessionStore write lifetime', () => {
	it('serializes append, projection and notifications', async () => {
		const storage = new DeferredStore()
		const { store, applied, notified } = setup(storage)
		const first = store.emit(event(1))
		const second = store.emit(event(2))
		await storage.entered.promise
		expect(storage.calls).toEqual([1])
		expect(applied).toEqual([])
		storage.gate.resolve()
		await Promise.all([first, second, store.waitForIdle()])
		expect(applied).toEqual([1, 2])
		expect(notified).toEqual([1, 2])
	})

	for (const failure of [new EventAppendOutcomeUnknownError(id), new Error('unclassified')]) {
		it(`fences queued and future appends after ${failure.name}`, async () => {
			const storage = new DeferredStore()
			storage.failure = failure
			const { store, applied } = setup(storage)
			const fences: unknown[] = []
			store.onFenced((error) => fences.push(error))
			const first = store.emit(event(1)).catch((error: unknown) => error)
			const second = store.emit(event(2)).catch((error: unknown) => error)
			await storage.entered.promise
			storage.gate.resolve()
			expect(await first).toBe(failure)
			// A write refused by the fence never reached the store: a definite noncommit.
			expect(await second).toBeInstanceOf(EventAppendError)
			expect(await second).toMatchObject({ cause: failure })
			await expect(store.emit(event(3))).rejects.toMatchObject({ cause: failure })
			await expect(store.waitForIdle()).rejects.toBe(failure)
			expect(storage.calls).toEqual([1])
			expect(applied).toEqual([])
			expect(fences).toEqual([failure])
		})
	}

	it('allows the next append after definite noncommit but reports the drain failure', async () => {
		const storage = new DeferredStore()
		storage.failure = new EventAppendError(id)
		const { store, applied } = setup(storage)
		const first = store.emit(event(1)).catch((error: unknown) => error)
		const second = store.emit(event(2))
		await storage.entered.promise
		storage.gate.resolve()
		expect(await first).toBe(storage.failure)
		await second
		expect(applied).toEqual([2])
		await expect(store.waitForIdle()).rejects.toBe(storage.failure)
	})

	it('reports a definite drain failure once, so a later drain can succeed', async () => {
		const storage = new DeferredStore()
		storage.failure = new EventAppendError(id)
		const { store } = setup(storage)
		const first = store.emit(event(1)).catch((error: unknown) => error)
		await storage.entered.promise
		storage.gate.resolve()
		expect(await first).toBe(storage.failure)

		// A definite noncommit is settled history: retaining it would refuse every
		// later park for the life of the runtime.
		await expect(store.waitForIdle()).rejects.toBe(storage.failure)
		await store.waitForIdle()
		await store.emit(event(2))
		await store.waitForIdle()
	})

	it('keeps writing after the closed-session guard refuses a hook event', async () => {
		const storage = new MemoryEventStore()
		const store = new SessionStore(id, storage, createSessionState(id, 'test', 0), (state) => state)
		await store.emit(withSessionId(id, sessionEvents.create('session_created', { presetId: 'test' })))
		await store.emit(withSessionId(id, sessionEvents.create('session_closed', {})))
		const hook = withSessionId(id, sessionEvents.create('session_handler_started', { handlerName: 'onSessionReady', pluginName: 'test' }))
		await expect(store.emit(hook)).rejects.toBeInstanceOf(ClosedSessionAppendError)
		await expect(store.waitForIdle()).rejects.toBeInstanceOf(ClosedSessionAppendError)
		await store.emit(withSessionId(id, sessionEvents.create('session_reopened', {})))
		expect(await storage.load(id)).toHaveLength(3)
	})

	it('does not time out a write for the time it spent queued behind healthy ones', async () => {
		class SlowStore extends MemoryEventStore {
			override async append(sessionId: SessionId, value: DomainEvent): Promise<void> {
				await Bun.sleep(30)
				await super.append(sessionId, value)
			}
		}
		const store = new SessionStore(id, new SlowStore(), createSessionState(id, 'test', 0), (state) => state, { queueTimeoutMs: 75 })
		const writes = [1, 2, 3, 4, 5].map((timestamp) => store.emit(event(timestamp)))
		await Promise.all(writes)
		await store.waitForIdle()
	})

	it('fails an append that does not settle, fences, and refuses what queued behind it', async () => {
		const storage = new DeferredStore()
		const { store, applied } = setup(storage, { queueTimeoutMs: 20 })
		const fences: unknown[] = []
		store.onFenced((error) => fences.push(error))
		const stalled = store.emit(event(1)).catch((error: unknown) => error)
		const queued = store.emit(event(2)).catch((error: unknown) => error)
		await storage.entered.promise
		// The head may still land, so its outcome is unknown; the write behind it never
		// reached the store, so it definitely did not commit.
		const unknown = await stalled
		expect(unknown).toBeInstanceOf(EventAppendOutcomeUnknownError)
		expect(await queued).toBeInstanceOf(EventAppendError)
		expect(await queued).toMatchObject({ cause: unknown })
		await expect(store.emit(event(3))).rejects.toMatchObject({ cause: unknown })
		expect(fences).toEqual([unknown])
		expect(storage.calls).toEqual([1])
		expect(store.hasPendingWrites()).toBe(true)
		storage.gate.resolve()
		await store.whenSettled()
		expect(store.hasPendingWrites()).toBe(false)
		expect(applied).toEqual([])
	})

	it('suppresses late projection and notification after detach', async () => {
		const storage = new DeferredStore()
		const { store, applied, notified } = setup(storage)
		const pending = store.emit(event(1)).catch((error: unknown) => error)
		await storage.entered.promise
		store.detach()
		expect(store.hasPendingWrites()).toBe(true)
		await expect(store.emit(event(2))).rejects.toBeInstanceOf(SessionRuntimeDetachedError)
		storage.gate.resolve()
		expect(await pending).toBeInstanceOf(SessionRuntimeDetachedError)
		expect(applied).toEqual([])
		expect(notified).toEqual([])
		expect(store.hasPendingWrites()).toBe(false)
	})
})
