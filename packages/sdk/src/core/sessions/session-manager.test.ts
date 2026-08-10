/**
 * SessionManager cold-load tests — how often the event log is read, and the
 * error each malformed / missing log produces.
 */

import { describe, expect, it } from 'bun:test'
import { MemoryEventStore } from '~/core/events/memory.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { DomainEvent } from '~/core/events/types.js'
import { SessionId } from '~/core/sessions/schema.js'
import { sessionEvents } from '~/core/sessions/state.js'
import { createTestPreset } from '~/testing/preset-helpers.js'
import { TestHarness } from '~/testing/test-harness.js'

/** MemoryEventStore that counts full-log reads, so a re-read cannot slip back in unnoticed. */
class CountingEventStore extends MemoryEventStore {
	loadCalls = 0

	async load(sessionId: SessionId): Promise<DomainEvent[]> {
		this.loadCalls++
		return super.load(sessionId)
	}
}

const newHarness = (eventStore: CountingEventStore) => new TestHarness({ presets: [createTestPreset()], eventStore })

describe('SessionManager cold load', () => {
	it('reads the event log once', async () => {
		const eventStore = new CountingEventStore()
		const seedHarness = new TestHarness({ presets: [createTestPreset()], eventStore })
		const created = await seedHarness.createSession('test')
		await seedHarness.shutdown()

		// Fresh manager over the same log — nothing cached, so this is a real cold load.
		const harness = newHarness(eventStore)
		eventStore.loadCalls = 0
		const result = await harness.sessionManager.getSession(created.sessionId)
		expect(result.ok).toBe(true)
		expect(eventStore.loadCalls).toBe(1)

		await harness.shutdown()
	})

	it('returns session_not_found for an unknown session', async () => {
		const eventStore = new CountingEventStore()
		const harness = newHarness(eventStore)

		const result = await harness.sessionManager.getSession(SessionId('does-not-exist'))

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.type).toBe('session_not_found')

		await harness.shutdown()
	})

	it('returns session_not_found when the log does not start with session_created', async () => {
		const eventStore = new CountingEventStore()
		const sessionId = SessionId('headless-log')
		await eventStore.append(sessionId, withSessionId(sessionId, sessionEvents.create('session_closed', {})))

		const harness = newHarness(eventStore)
		const result = await harness.sessionManager.getSession(sessionId)

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.type).toBe('session_not_found')

		await harness.shutdown()
	})

	it('returns preset_not_found when the log references an unknown preset', async () => {
		const eventStore = new CountingEventStore()
		const sessionId = SessionId('unknown-preset')
		await eventStore.append(
			sessionId,
			withSessionId(sessionId, sessionEvents.create('session_created', { presetId: 'gone' })),
		)

		const harness = newHarness(eventStore)
		const result = await harness.sessionManager.getSession(sessionId)

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.type).toBe('preset_not_found')

		await harness.shutdown()
	})
})

describe('SessionManager session counts', () => {
	it('counts stored sessions without loading any of them', async () => {
		const eventStore = new CountingEventStore()
		const seedHarness = new TestHarness({ presets: [createTestPreset()], eventStore })
		await seedHarness.createSession('test')
		await seedHarness.createSession('test')
		await seedHarness.shutdown()

		// A manager that has never seen either session — the state a Durable Object
		// wakes up in. getStats() reports its own memory; the count reports the store.
		const harness = newHarness(eventStore)
		eventStore.loadCalls = 0

		const stats = await harness.sessionManager.getStats()
		expect(stats.sessionCount).toBe(0)
		expect(stats.lastActivityAt).toBeNull()

		expect(await harness.sessionManager.countStoredSessions()).toBe(2)
		// Replay is the expensive operation; counting must never pay for it.
		expect(eventStore.loadCalls).toBe(0)

		await harness.shutdown()
	})
})
