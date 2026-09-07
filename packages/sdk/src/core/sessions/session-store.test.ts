import { describe, expect, it } from 'bun:test'
import { EventAppendError, EventAppendOutcomeUnknownError } from '../events/event-store.js'
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

function setup(storage: DeferredStore) {
	const applied: number[] = []
	const notified: number[] = []
	const store = new SessionStore(id, storage, createSessionState(id, 'test', 0), (state, value) => {
		applied.push(value.timestamp)
		return state
	})
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
			const first = store.emit(event(1)).catch((error: unknown) => error)
			const second = store.emit(event(2)).catch((error: unknown) => error)
			await storage.entered.promise
			storage.gate.resolve()
			expect(await first).toBe(failure)
			expect(await second).toBe(failure)
			await expect(store.emit(event(3))).rejects.toBe(failure)
			await expect(store.waitForIdle()).rejects.toBe(failure)
			expect(storage.calls).toEqual([1])
			expect(applied).toEqual([])
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
