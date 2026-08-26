import { Database } from 'bun:sqlite'
import type { SQLQueryBindings } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { isDomainEvent, SessionId } from '@roj-ai/sdk'
import type { DomainEvent, SessionMetadata } from '@roj-ai/sdk'
import { EventAppendError, EventStoreError } from '@roj-ai/sdk'
import { SqliteEventStore } from './sqlite-event-store.js'
import type { SqlCursorLike, SqlStorageHost, SqlStorageLike } from './sqlite-event-store.js'

function toBinding(value: unknown): SQLQueryBindings {
	if (
		value === null || typeof value === 'string' || typeof value === 'number'
		|| typeof value === 'bigint' || typeof value === 'boolean'
	) {
		return value
	}
	throw new Error(`Unsupported SQL binding: ${String(value)}`)
}

/** A Durable Object rejects a statement binding more than this; bun:sqlite does not. */
const DO_MAX_SQL_VARIABLES = 100

/** bun:sqlite standing in for a Durable Object's SQL surface. */
class FakeSqlStorage implements SqlStorageHost {
	private readonly db = new Database(':memory:')

	/** Fault injection, so append failures can be exercised without corrupting the schema. */
	failOn: ((query: string) => boolean) | null = null

	readonly sql: SqlStorageLike = {
		exec: <Row extends object>(query: string, ...bindings: unknown[]): SqlCursorLike<Row> => {
			if (this.failOn?.(query)) throw new Error('injected SQL failure')
			// Enforced here because bun:sqlite allows ~32k, so an over-bound statement
			// would pass in tests and fail only on a real Durable Object.
			if (bindings.length > DO_MAX_SQL_VARIABLES) {
				throw new Error(`too many SQL variables at offset ${bindings.length}: SQLITE_ERROR`)
			}
			const rows = this.db.query<Row, SQLQueryBindings[]>(query).all(...bindings.map(toBinding))
			return { toArray: () => rows }
		},
	}
}

function makeEvent(
	sessionId: SessionId,
	type: string,
	payload: Record<string, unknown> = {},
	timestamp = Date.now(),
): DomainEvent {
	const event: unknown = { sessionId, timestamp, type, ...payload }
	// DomainEvent is branded; the SDK's own guard is the only honest way to produce one.
	if (!isDomainEvent(event)) throw new Error('constructed event is not a DomainEvent')
	return event
}

const sessionCreated = (sessionId: SessionId, presetId: string, timestamp?: number) =>
	makeEvent(sessionId, 'session_created', { presetId }, timestamp)

const agentSpawned = (sessionId: SessionId, definitionName: string, timestamp?: number) =>
	makeEvent(sessionId, 'agent_spawned', { agentId: `agent-${definitionName}`, definitionName, parentId: null }, timestamp)

/** `updateMetadata` drops a partial it cannot complete, so a metadata-only session needs a whole record. */
const metadataOnly: Partial<SessionMetadata> = {
	presetId: 'test-preset',
	createdAt: 1000,
	status: 'active',
	name: 'metadata only',
}

describe('SqliteEventStore', () => {
	let storage: FakeSqlStorage
	let store: SqliteEventStore
	let sessionId: SessionId

	beforeEach(() => {
		storage = new FakeSqlStorage()
		store = new SqliteEventStore(storage)
		sessionId = SessionId('01900000-0000-7000-8000-000000000001')
	})

	describe('append', () => {
		test('appends a single event', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset'))

			const loaded = await store.load(sessionId)
			expect(loaded).toHaveLength(1)
			expect(loaded[0]).toMatchObject({ type: 'session_created', sessionId, presetId: 'test-preset' })
		})

		test('appends multiple events sequentially', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset'))
			await store.append(sessionId, agentSpawned(sessionId, 'test-agent'))

			const loaded = await store.load(sessionId)
			expect(loaded.map((event) => event.type)).toEqual(['session_created', 'agent_spawned'])
		})

		test('keeps unknown payload fields intact', async () => {
			await store.append(sessionId, makeEvent(sessionId, 'custom_event', { nested: { a: [1, 2] }, flag: false }))

			const loaded = await store.load(sessionId)
			expect(loaded[0]).toMatchObject({ nested: { a: [1, 2] }, flag: false })
		})

		test('isolates events per session', async () => {
			const other = SessionId('01900000-0000-7000-8000-000000000002')

			await store.append(sessionId, sessionCreated(sessionId, 'a'))
			await store.append(other, sessionCreated(other, 'b'))
			await store.append(sessionId, agentSpawned(sessionId, 'agent-1'))

			expect(await store.load(sessionId)).toHaveLength(2)
			expect(await store.load(other)).toHaveLength(1)
		})

		test('serializes concurrent appends into one metric total', async () => {
			await Promise.all([
				store.append(sessionId, sessionCreated(sessionId, 'test-preset')),
				store.append(sessionId, agentSpawned(sessionId, 'a')),
				store.append(sessionId, agentSpawned(sessionId, 'b')),
			])

			const loaded = await store.load(sessionId)
			expect(loaded).toHaveLength(3)

			const metadata = await store.getMetadata(sessionId)
			expect(metadata?.metrics?.totalEvents).toBe(3)
			expect(metadata?.metrics?.totalAgents).toBe(2)
		})
	})

	describe('appendBatch', () => {
		test('appends a batch in order', async () => {
			await store.appendBatch(sessionId, [
				sessionCreated(sessionId, 'test-preset'),
				agentSpawned(sessionId, 'test-agent'),
			])

			const loaded = await store.load(sessionId)
			expect(loaded.map((event) => event.type)).toEqual(['session_created', 'agent_spawned'])
		})

		test('handles an empty batch', async () => {
			await store.appendBatch(sessionId, [])

			expect(await store.load(sessionId)).toHaveLength(0)
			expect(await store.exists(sessionId)).toBe(false)
		})

		test('continues numbering after earlier appends', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset'))
			await store.appendBatch(sessionId, [agentSpawned(sessionId, 'a'), agentSpawned(sessionId, 'b')])

			const result = await store.loadRange(sessionId, { since: 0 })
			expect(result.fromIndex).toBe(1)
			expect(result.toIndex).toBe(2)
		})

		test('numbers a large batch contiguously', async () => {
			await store.appendBatch(
				sessionId,
				Array.from({ length: 200 }, (_, index) => agentSpawned(sessionId, `a${index}`, 1000 + index)),
			)

			const result = await store.loadRange(sessionId)
			expect(result.events).toHaveLength(200)
			expect(result.fromIndex).toBe(0)
			expect(result.toIndex).toBe(199)
		})

		test('reports a failed insert and leaves nothing behind', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset'))
			storage.failOn = (query) => query.startsWith('INSERT INTO roj_events')

			await expect(store.appendBatch(sessionId, [agentSpawned(sessionId, 'a'), agentSpawned(sessionId, 'b')]))
				.rejects.toThrow(EventAppendError)

			storage.failOn = null
			expect(await store.load(sessionId)).toHaveLength(1)
			expect((await store.getMetadata(sessionId))?.metrics?.totalEvents).toBe(1)
		})

		test('wraps a payload that cannot be serialized', async () => {
			const circular: Record<string, unknown> = {}
			circular.self = circular

			await expect(store.appendBatch(sessionId, [makeEvent(sessionId, 'bad_event', { circular })]))
				.rejects.toThrow(EventAppendError)
			expect(await store.load(sessionId)).toHaveLength(0)
		})
	})

	describe('load', () => {
		test('returns an empty array for an unknown session', async () => {
			expect(await store.load(SessionId('missing'))).toEqual([])
		})

		test('loads events in append order', async () => {
			await store.appendBatch(
				sessionId,
				Array.from({ length: 5 }, (_, index) => sessionCreated(sessionId, `preset-${index}`, 1000 + index)),
			)

			const loaded = await store.load(sessionId)
			expect(loaded).toHaveLength(5)
			expect(loaded.map((event) => event.timestamp)).toEqual([1000, 1001, 1002, 1003, 1004])
		})

		test('survives a new store over the same storage', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset'))

			const reopened = new SqliteEventStore(storage)
			expect(await reopened.load(sessionId)).toHaveLength(1)
			expect((await reopened.getMetadata(sessionId))?.presetId).toBe('test-preset')
		})
	})

	describe('loadRange', () => {
		const seed = async (count: number) => {
			await store.appendBatch(
				sessionId,
				Array.from({ length: count }, (_, index) => sessionCreated(sessionId, `preset-${index}`, 1000 + index)),
			)
		}

		test('returns an empty result for an unknown session', async () => {
			const result = await store.loadRange(SessionId('missing'))
			expect(result).toEqual({ events: [], fromIndex: -1, toIndex: -1 })
		})

		test('returns every event when no options are given', async () => {
			await seed(2)

			const result = await store.loadRange(sessionId)
			expect(result.events).toHaveLength(2)
			expect(result.fromIndex).toBe(0)
			expect(result.toIndex).toBe(1)
		})

		test('returns events after the since index', async () => {
			await seed(10)

			const result = await store.loadRange(sessionId, { since: 7 })
			expect(result.events).toHaveLength(2)
			expect(result.fromIndex).toBe(8)
			expect(result.toIndex).toBe(9)
			expect(result.events[0]).toMatchObject({ presetId: 'preset-8' })
			expect(result.events[1]).toMatchObject({ presetId: 'preset-9' })
		})

		test('returns an empty page but keeps the cursor when since equals the last index', async () => {
			await seed(1)

			const result = await store.loadRange(sessionId, { since: 0 })
			expect(result.events).toEqual([])
			expect(result.fromIndex).toBe(-1)
			expect(result.toIndex).toBe(0)
		})

		test('returns an empty page but keeps the cursor when since is past the end', async () => {
			await seed(1)

			const result = await store.loadRange(sessionId, { since: 10 })
			expect(result.events).toEqual([])
			expect(result.fromIndex).toBe(-1)
			expect(result.toIndex).toBe(0)
		})

		test('respects limit and reports the last returned index', async () => {
			await seed(10)

			const result = await store.loadRange(sessionId, { since: 5, limit: 3 })
			expect(result.events).toHaveLength(3)
			expect(result.fromIndex).toBe(6)
			expect(result.toIndex).toBe(8)
			expect(result.events.map((event) => event.timestamp)).toEqual([1006, 1007, 1008])
		})

		test('caps limit at what is available', async () => {
			await seed(3)

			const result = await store.loadRange(sessionId, { since: 1, limit: 100 })
			expect(result.events).toHaveLength(1)
			expect(result.fromIndex).toBe(2)
			expect(result.toIndex).toBe(2)
		})

		test('treats limit 0 as an empty page', async () => {
			await seed(3)

			const result = await store.loadRange(sessionId, { since: 0, limit: 0 })
			expect(result.events).toEqual([])
			expect(result.fromIndex).toBe(-1)
			expect(result.toIndex).toBe(2)
		})

		test('polls to the end one page at a time', async () => {
			await seed(5)

			const seen: number[] = []
			let cursor = -1
			for (let page = 0; page < 10; page++) {
				const result = await store.loadRange(sessionId, { since: cursor, limit: 2 })
				if (result.events.length === 0) break
				seen.push(...result.events.map((event) => event.timestamp))
				cursor = result.toIndex
			}

			expect(seen).toEqual([1000, 1001, 1002, 1003, 1004])
			expect(cursor).toBe(4)
		})
	})

	describe('exists', () => {
		test('returns false for an unknown session', async () => {
			expect(await store.exists(SessionId('missing'))).toBe(false)
		})

		test('returns true once an event landed', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset'))
			expect(await store.exists(sessionId)).toBe(true)
		})

		test('stays false for a session that only has metadata', async () => {
			await store.updateMetadata(sessionId, metadataOnly)
			expect(await store.exists(sessionId)).toBe(false)
		})
	})

	describe('listSessions', () => {
		test('returns an empty array when nothing was stored', async () => {
			expect(await store.listSessions()).toEqual([])
		})

		test('returns every session id once', async () => {
			const ids = [
				SessionId('01900000-0000-7000-8000-00000000000a'),
				SessionId('01900000-0000-7000-8000-00000000000b'),
				SessionId('01900000-0000-7000-8000-00000000000c'),
			]
			for (const id of ids) {
				await store.appendBatch(id, [sessionCreated(id, 'test'), agentSpawned(id, 'a')])
			}

			const sessions = await store.listSessions()
			expect(sessions).toHaveLength(3)
			for (const id of ids) expect(sessions).toContain(id)
		})

		test('returns them in id order', async () => {
			const ids = [
				SessionId('01900000-0000-7000-8000-00000000000c'),
				SessionId('01900000-0000-7000-8000-00000000000a'),
				SessionId('01900000-0000-7000-8000-00000000000b'),
			]
			for (const id of ids) await store.append(id, sessionCreated(id, 'test'))

			expect(await store.listSessions()).toEqual([...ids].sort())
		})

		test('includes a session that only has metadata', async () => {
			await store.updateMetadata(sessionId, metadataOnly)
			expect(await store.listSessions()).toEqual([sessionId])
		})

		test('includes a session whose metadata write failed after its events landed', async () => {
			// The events insert is synchronous and the metadata write that follows it is
			// not, so a metadata failure leaves the log as the only record of the session.
			storage.failOn = (query) => query.startsWith('INSERT INTO roj_session_metadata')

			await expect(store.append(sessionId, sessionCreated(sessionId, 'test-preset')))
				.rejects.toThrow(EventAppendError)

			storage.failOn = null
			expect(await store.getMetadata(sessionId)).toBeNull()
			expect(await store.load(sessionId)).toHaveLength(1)
			expect(await store.listSessions()).toEqual([sessionId])
		})
	})

	describe('metadata', () => {
		test('returns null for an unknown session', async () => {
			expect(await store.getMetadata(SessionId('missing'))).toBeNull()
		})

		test('is created from the session_created event', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset', 1000))

			const metadata = await store.getMetadata(sessionId)
			expect(metadata).toMatchObject({
				sessionId,
				presetId: 'test-preset',
				createdAt: 1000,
				lastActivityAt: 1000,
				status: 'active',
			})
			expect(metadata?.metrics).toMatchObject({ totalEvents: 1, totalAgents: 0, totalTokens: 0, totalLLMCalls: 0 })
		})

		test('accumulates metrics across appends', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset', 1000))
			await store.append(sessionId, agentSpawned(sessionId, 'test-agent', 2000))
			await store.append(sessionId, makeEvent(sessionId, 'inference_completed', {
				agentId: 'agent-1',
				metrics: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.25 },
			}, 3000))

			const metadata = await store.getMetadata(sessionId)
			expect(metadata?.lastActivityAt).toBe(3000)
			expect(metadata?.metrics).toMatchObject({
				totalEvents: 3,
				totalAgents: 1,
				totalTokens: 150,
				totalLLMCalls: 1,
				inputTokens: 100,
				outputTokens: 50,
				totalCost: 0.25,
			})
		})

		test('tracks status through close and reopen', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset', 1000))
			await store.append(sessionId, makeEvent(sessionId, 'session_closed', {}, 2000))
			expect((await store.getMetadata(sessionId))?.status).toBe('closed')

			await store.append(sessionId, makeEvent(sessionId, 'session_reopened', {}, 3000))
			expect((await store.getMetadata(sessionId))?.status).toBe('active')
		})

		test('round-trips name, tags and custom data', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset', 1000))
			await store.updateMetadata(sessionId, {
				name: 'My Session',
				tags: ['tag1', 'tag2'],
				custom: { branch: 'main', retries: 2 },
			})

			const metadata = await store.getMetadata(sessionId)
			expect(metadata?.name).toBe('My Session')
			expect(metadata?.tags).toEqual(['tag1', 'tag2'])
			expect(metadata?.custom).toEqual({ branch: 'main', retries: 2 })
			expect(metadata?.presetId).toBe('test-preset')
		})

		test('reconciles metrics that drifted from the events', async () => {
			await store.appendBatch(sessionId, [sessionCreated(sessionId, 'test-preset', 1000), agentSpawned(sessionId, 'a', 2000)])
			await store.updateMetadata(sessionId, {
				metrics: { totalEvents: 99, totalAgents: 99, totalTokens: 0, totalLLMCalls: 0 },
			})

			const events = await store.load(sessionId)
			expect(await store.reconcileMetadata(sessionId, events)).toBe(true)
			expect((await store.getMetadata(sessionId))?.metrics?.totalEvents).toBe(2)
		})

		test('refuses a session hook event on a closed session', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset', 1000))
			await store.append(sessionId, makeEvent(sessionId, 'session_closed', {}, 2000))

			await expect(store.append(sessionId, makeEvent(sessionId, 'session_handler_started', {}, 3000)))
				.rejects.toThrow(/closed session/)
			expect(await store.load(sessionId)).toHaveLength(2)
		})
	})

	describe('listSessionsWithMetadata', () => {
		const first = SessionId('01900000-0000-7000-8000-0000000000a1')
		const second = SessionId('01900000-0000-7000-8000-0000000000a2')

		test('returns an empty list when nothing was stored', async () => {
			expect(await store.listSessionsWithMetadata()).toEqual({ sessions: [], total: 0 })
		})

		test('filters by status', async () => {
			await store.append(first, sessionCreated(first, 'preset-1', 1000))
			await store.append(second, sessionCreated(second, 'preset-2', 2000))
			await store.append(second, makeEvent(second, 'session_closed', {}, 3000))

			const active = await store.listSessionsWithMetadata({ status: 'active' })
			expect(active.sessions.map((session) => session.sessionId)).toEqual([first])

			const closed = await store.listSessionsWithMetadata({ status: 'closed' })
			expect(closed.sessions.map((session) => session.sessionId)).toEqual([second])
		})

		test('filters by tags', async () => {
			await store.append(first, sessionCreated(first, 'preset-1', 1000))
			await store.append(second, sessionCreated(second, 'preset-2', 2000))
			await store.updateMetadata(first, { tags: ['important', 'project-a'] })
			await store.updateMetadata(second, { tags: ['project-b'] })

			const result = await store.listSessionsWithMetadata({ tags: ['important'] })
			expect(result.sessions.map((session) => session.sessionId)).toEqual([first])
		})

		test('sorts and paginates', async () => {
			const ids = Array.from({ length: 5 }, (_, index) => SessionId(`01900000-0000-7000-8000-0000000000b${index}`))
			for (const [index, id] of ids.entries()) {
				await store.append(id, sessionCreated(id, `preset-${index}`, index * 1000))
			}

			const page = await store.listSessionsWithMetadata({ limit: 2, offset: 2, orderBy: 'createdAt', order: 'asc' })
			expect(page.total).toBe(5)
			expect(page.sessions.map((session) => session.presetId)).toEqual(['preset-2', 'preset-3'])
		})
	})

	describe('deleteSession', () => {
		const other = SessionId('01900000-0000-7000-8000-0000000000c1')

		test('removes the events and the metadata of one session', async () => {
			await store.appendBatch(sessionId, [sessionCreated(sessionId, 'test'), agentSpawned(sessionId, 'a')])

			expect(await store.deleteSession(sessionId)).toBe(2)
			expect(await store.load(sessionId)).toEqual([])
			expect(await store.exists(sessionId)).toBe(false)
			expect(await store.getMetadata(sessionId)).toBeNull()
			expect(await store.listSessions()).toEqual([])
		})

		test('leaves every other session alone', async () => {
			await store.appendBatch(sessionId, [sessionCreated(sessionId, 'test'), agentSpawned(sessionId, 'a')])
			await store.appendBatch(other, [sessionCreated(other, 'test'), agentSpawned(other, 'b')])

			await store.deleteSession(sessionId)

			expect(await store.load(other)).toHaveLength(2)
			expect(await store.getMetadata(other)).toMatchObject({ sessionId: other })
			expect(await store.listSessions()).toEqual([other])
		})

		test('reports zero for a session that was never stored', async () => {
			expect(await store.deleteSession(SessionId('missing'))).toBe(0)
		})

		test('removes a session that only has metadata', async () => {
			await store.updateMetadata(sessionId, metadataOnly)

			expect(await store.deleteSession(sessionId)).toBe(0)
			expect(await store.listSessions()).toEqual([])
		})

		test('numbers a later append from zero again', async () => {
			await store.appendBatch(sessionId, [sessionCreated(sessionId, 'test'), agentSpawned(sessionId, 'a')])
			await store.deleteSession(sessionId)

			await store.append(sessionId, sessionCreated(sessionId, 'reused'))

			const range = await store.loadRange(sessionId)
			expect(range.fromIndex).toBe(0)
			expect(range.toIndex).toBe(0)
		})

		test('does not split a batch that is already in flight', async () => {
			const append = store.appendBatch(sessionId, [sessionCreated(sessionId, 'test'), agentSpawned(sessionId, 'a')])
			const deleted = store.deleteSession(sessionId)

			await append
			expect(await deleted).toBe(2)
			expect(await store.load(sessionId)).toEqual([])
		})
	})

	describe('error handling', () => {
		test('throws EventStoreError when a stored event is not JSON', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset'))
			storage.sql.exec('UPDATE roj_events SET payload = ? WHERE session_id = ? AND seq = 0', 'not json', sessionId)

			await expect(store.load(sessionId)).rejects.toThrow(EventStoreError)
			await expect(store.loadRange(sessionId)).rejects.toThrow(EventStoreError)
		})

		test('throws EventStoreError when a stored event is not a domain event', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset'))
			storage.sql.exec('UPDATE roj_events SET payload = ? WHERE session_id = ? AND seq = 0', '{"type":"x"}', sessionId)

			await expect(store.load(sessionId)).rejects.toThrow(EventStoreError)
		})

		test('throws EventStoreError when stored metadata is corrupt', async () => {
			await store.append(sessionId, sessionCreated(sessionId, 'test-preset'))
			storage.sql.exec('UPDATE roj_session_metadata SET metadata = ? WHERE session_id = ?', '[]', sessionId)

			await expect(store.getMetadata(sessionId)).rejects.toThrow(EventStoreError)
			await expect(store.listSessionsWithMetadata()).rejects.toThrow(EventStoreError)
		})
	})
})
