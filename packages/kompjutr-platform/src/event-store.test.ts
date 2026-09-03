import { isDomainEvent, SessionId } from '@roj-ai/sdk'
import type { DomainEvent } from '@roj-ai/sdk'
import { beforeEach, expect, test } from 'bun:test'
import { Database } from 'kompjutr'
import type { SqlDatabase } from 'kompjutr'
import { KompjutrEventStore } from './event-store.js'
import { BunSqliteStorage } from './testing/storage.js'

const SESSION = SessionId('session-a')
const OTHER = SessionId('session-b')

let db: SqlDatabase
let store: KompjutrEventStore

beforeEach(() => {
	db = new Database(new BunSqliteStorage())
	store = new KompjutrEventStore(db)
})

/** The SDK's own guard, so a hand-built event is one by its definition rather than by a cast. */
function event(sessionId: SessionId, type: string, payload: Record<string, unknown> = {}): DomainEvent {
	const candidate = { type, sessionId, timestamp: Date.now(), ...payload }
	if (!isDomainEvent(candidate)) throw new Error(`not a domain event: ${type}`)
	return candidate
}

function created(sessionId: SessionId): DomainEvent {
	return event(sessionId, 'session_created', { presetId: 'test-preset' })
}

test('an appended event loads back', async () => {
	await store.append(SESSION, created(SESSION))

	const loaded = await store.load(SESSION)
	expect(loaded).toHaveLength(1)
	expect(loaded[0]?.type).toBe('session_created')
})

test('a batch wider than one statement can bind lands whole', async () => {
	// 33 events is what fits in a Durable Object's 100 bind parameters at three
	// per row. The previous implementation of this store inserted a batch in one
	// statement and passed its tests because the fake bound thousands.
	const events = Array.from({ length: 100 }, (_, index) => event(SESSION, 'test_event', { index }))

	await store.appendBatch(SESSION, events)

	const loaded = await store.load(SESSION)
	expect(loaded).toHaveLength(100)
	expect(loaded.map((entry) => 'index' in entry && typeof entry.index === 'number' ? entry.index : undefined))
		.toEqual(Array.from({ length: 100 }, (_, index) => index))
})

test('a batch that fails part way through leaves nothing behind', async () => {
	await store.append(SESSION, created(SESSION))

	// Fail the second INSERT, so the first chunk has already landed when it does.
	// That is the case the transaction exists for and the one a dropped table
	// cannot reach: there, every chunk fails and a rollback proves nothing.
	let inserts = 0
	const failing = new KompjutrEventStore({
		...db,
		run: (query: string, ...bindings: unknown[]) => {
			if (query.includes('INSERT INTO roj_events') && ++inserts === 2) throw new Error('storage full')
			db.run(query, ...bindings)
		},
		all: db.all.bind(db),
		one: db.one.bind(db),
		scalar: db.scalar.bind(db),
		iterate: db.iterate.bind(db),
		transactionSync: db.transactionSync.bind(db),
	})

	const events = Array.from({ length: 50 }, (_, index) => event(SESSION, 'test_event', { index }))
	await expect(failing.appendBatch(SESSION, events)).rejects.toThrow()

	// The 33 rows of the first chunk went with the rollback; the earlier event stands.
	expect(await store.load(SESSION)).toHaveLength(1)
})

test('loadRange returns what followed the cursor, and holds it when nothing did', async () => {
	await store.appendBatch(SESSION, [created(SESSION), event(SESSION, 'a'), event(SESSION, 'b')])

	const all = await store.loadRange(SESSION)
	expect(all.events).toHaveLength(3)
	expect(all.fromIndex).toBe(0)
	expect(all.toIndex).toBe(2)

	const tail = await store.loadRange(SESSION, { since: all.toIndex })
	expect(tail.events).toEqual([])
	// A poller must keep its place rather than rewind to the start.
	expect(tail.toIndex).toBe(2)

	const page = await store.loadRange(SESSION, { since: -1, limit: 2 })
	expect(page.events).toHaveLength(2)
	expect(page.toIndex).toBe(1)
})

test('exists follows the events, not the metadata', async () => {
	expect(await store.exists(SESSION)).toBe(false)
	await store.append(SESSION, created(SESSION))
	expect(await store.exists(SESSION)).toBe(true)
})

test('listSessions unions both tables', async () => {
	await store.append(SESSION, created(SESSION))
	// Metadata without a single event — a session created but never written to.
	// The merge is validated whole, so a partial over no existing record writes nothing.
	await store.updateMetadata(OTHER, { presetId: 'other-preset', status: 'active', createdAt: Date.now() })

	expect(await store.listSessions()).toEqual([SESSION, OTHER].sort())
})

test('metadata round-trips through the schema', async () => {
	await store.append(SESSION, created(SESSION))

	const metadata = await store.getMetadata(SESSION)
	expect(metadata?.sessionId).toBe(SESSION)
	expect(metadata?.presetId).toBe('test-preset')
	expect(metadata?.status).toBe('active')
})

test('a metadata row that does not parse is skipped, not thrown over', async () => {
	await store.append(SESSION, created(SESSION))
	await store.append(OTHER, created(OTHER))
	db.run('UPDATE roj_session_metadata SET metadata = ? WHERE session_id = ?', '{"nonsense":true}', SESSION)

	// A fresh store, so the good row is not answered from a cache the bad one bypassed.
	const reopened = new KompjutrEventStore(db)
	expect(await reopened.getMetadata(SESSION)).toBeNull()
	const listed = await reopened.listSessionsWithMetadata()
	expect(listed.sessions.map((entry) => entry.sessionId)).toEqual([OTHER])
})

test('deleteSession drops both tables and reports the events', async () => {
	await store.appendBatch(SESSION, [created(SESSION), event(SESSION, 'a')])
	await store.append(OTHER, created(OTHER))

	expect(await store.deleteSession(SESSION)).toBe(2)
	expect(await store.exists(SESSION)).toBe(false)
	expect(await store.getMetadata(SESSION)).toBeNull()
	expect(await store.exists(OTHER)).toBe(true)
	expect(await store.deleteSession(SessionId('never-written'))).toBe(0)
})

test('a session does not see another session events', async () => {
	await store.append(SESSION, created(SESSION))
	await store.append(OTHER, created(OTHER))

	expect(await store.load(SESSION)).toHaveLength(1)
	expect(await store.load(OTHER)).toHaveLength(1)
})
