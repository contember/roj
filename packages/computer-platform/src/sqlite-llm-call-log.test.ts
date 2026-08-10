import { Database } from 'bun:sqlite'
import type { SQLQueryBindings } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { LLMCallRow } from '@roj-ai/sdk/platform'
import type { SqlCursorLike, SqlStorageHost, SqlStorageLike } from './sqlite-event-store.js'
import { SqliteLLMCallLog } from './sqlite-llm-call-log.js'

function toBinding(value: unknown): SQLQueryBindings {
	if (
		value === null || typeof value === 'string' || typeof value === 'number'
		|| typeof value === 'bigint' || typeof value === 'boolean'
	) {
		return value
	}
	throw new Error(`Unsupported SQL binding: ${String(value)}`)
}

/** bun:sqlite standing in for a Durable Object's SQL surface. */
class FakeSqlStorage implements SqlStorageHost {
	private readonly db = new Database(':memory:')

	readonly sql: SqlStorageLike = {
		exec: <Row extends object>(query: string, ...bindings: unknown[]): SqlCursorLike<Row> => {
			const rows = this.db.query<Row, SQLQueryBindings[]>(query).all(...bindings.map(toBinding))
			return { toArray: () => rows }
		},
	}
}

const SESSION = '01900000-0000-7000-8000-000000000001'
const OTHER = '01900000-0000-7000-8000-000000000002'

/** UUIDv7-shaped, so the lexicographic order under test is the real one. */
const callId = (n: number) => `0199a1b2-c3d4-7000-8000-${String(n).padStart(12, '0')}`

const row = (n: number, overrides: Partial<LLMCallRow> = {}): LLMCallRow => ({
	callId: callId(n),
	agentId: 'agent-1',
	createdAt: 1_700_000_000_000 + n,
	status: 'running',
	model: 'anthropic/claude',
	request: JSON.stringify({ model: 'anthropic/claude', systemPrompt: 'sp', messages: [{ role: 'user', content: `m${n}` }], toolsCount: 0 }),
	...overrides,
})

const ids = (calls: LLMCallRow[]) => calls.map((call) => call.callId)

describe('SqliteLLMCallLog', () => {
	let storage: FakeSqlStorage
	let log: SqliteLLMCallLog

	beforeEach(() => {
		storage = new FakeSqlStorage()
		log = new SqliteLLMCallLog(storage)
	})

	test('reads a created call back whole', async () => {
		await log.create(SESSION, row(1))

		expect(await log.get(SESSION, callId(1))).toEqual(row(1))
	})

	test('reports a call it does not hold', async () => {
		expect(await log.get(SESSION, callId(9))).toBeNull()
	})

	test('completing writes the outcome and leaves the request alone', async () => {
		await log.create(SESSION, row(1))

		await log.complete(SESSION, callId(1), {
			status: 'success',
			completedAt: 1_700_000_001_000,
			durationMs: 420,
			providerRequestId: 'gen-1',
			response: '{"content":"hi"}',
			metrics: '{"totalTokens":15}',
		})

		expect(await log.get(SESSION, callId(1))).toEqual({
			...row(1),
			status: 'success',
			completedAt: 1_700_000_001_000,
			durationMs: 420,
			providerRequestId: 'gen-1',
			response: '{"content":"hi"}',
			metrics: '{"totalTokens":15}',
		})
	})

	test('completing with an error keeps the response columns empty', async () => {
		await log.create(SESSION, row(1))

		await log.complete(SESSION, callId(1), {
			status: 'error',
			completedAt: 1_700_000_001_000,
			durationMs: 5,
			error: '{"type":"rate_limit"}',
		})

		const stored = await log.get(SESSION, callId(1))
		expect(stored?.status).toBe('error')
		expect(stored?.error).toBe('{"type":"rate_limit"}')
		expect(stored?.response).toBeUndefined()
		expect(stored?.metrics).toBeUndefined()
	})

	test('completing a call the store no longer holds does nothing', async () => {
		// A reap between the two halves of one inference, which must not throw.
		await log.complete(SESSION, callId(1), { status: 'success', completedAt: 1, durationMs: 1 })

		expect(await log.get(SESSION, callId(1))).toBeNull()
	})

	test('lists newest first, the order the sorted readdir gave', async () => {
		await log.create(SESSION, row(1))
		await log.create(SESSION, row(2))
		await log.create(SESSION, row(3))

		const page = await log.list(SESSION, { limit: 100, offset: 0 })

		expect(ids(page.calls)).toEqual([callId(3), callId(2), callId(1)])
		expect(page.total).toBe(3)
	})

	test('pages without overlapping or skipping, and totals before the page', async () => {
		for (let n = 1; n <= 5; n++) await log.create(SESSION, row(n))

		const first = await log.list(SESSION, { limit: 2, offset: 0 })
		const second = await log.list(SESSION, { limit: 2, offset: 2 })
		const third = await log.list(SESSION, { limit: 2, offset: 4 })

		expect(ids(first.calls)).toEqual([callId(5), callId(4)])
		expect(ids(second.calls)).toEqual([callId(3), callId(2)])
		expect(ids(third.calls)).toEqual([callId(1)])
		expect([first.total, second.total, third.total]).toEqual([5, 5, 5])
	})

	test('lists empty for a session that never called', async () => {
		expect(await log.list(SESSION, { limit: 100, offset: 0 })).toEqual({ calls: [], total: 0 })
	})

	test('keeps sessions apart', async () => {
		await log.create(SESSION, row(1))
		await log.create(OTHER, row(2))
		await log.create(SESSION, row(3))

		expect(ids((await log.list(SESSION, { limit: 100, offset: 0 })).calls)).toEqual([callId(3), callId(1)])
		expect(ids((await log.list(OTHER, { limit: 100, offset: 0 })).calls)).toEqual([callId(2)])
	})

	test('delete reports what went and leaves other sessions alone', async () => {
		await log.create(SESSION, row(1))
		await log.create(SESSION, row(2))
		await log.create(OTHER, row(3))

		expect(await log.delete(SESSION)).toBe(2)
		expect(await log.list(SESSION, { limit: 100, offset: 0 })).toEqual({ calls: [], total: 0 })
		expect((await log.list(OTHER, { limit: 100, offset: 0 })).total).toBe(1)
	})

	test('delete of a session that never called reports nothing', async () => {
		expect(await log.delete(SESSION)).toBe(0)
	})

	test('sees what a previous isolate stored', async () => {
		await log.create(SESSION, row(1))

		// A second instance over the same storage is what an evicted isolate coming back is.
		const reopened = new SqliteLLMCallLog(storage)
		await reopened.create(SESSION, row(2))

		expect(ids((await reopened.list(SESSION, { limit: 100, offset: 0 })).calls)).toEqual([callId(2), callId(1)])
	})

	describe('retention', () => {
		test('keeps the newest calls up to the cap and drops the rest', async () => {
			const capped = new SqliteLLMCallLog(storage, { maxCallsPerSession: 3 })
			for (let n = 1; n <= 6; n++) await capped.create(SESSION, row(n))

			const page = await capped.list(SESSION, { limit: 100, offset: 0 })
			expect(ids(page.calls)).toEqual([callId(6), callId(5), callId(4)])
			expect(page.total).toBe(3)
		})

		test('trims only the session that just wrote', async () => {
			const capped = new SqliteLLMCallLog(storage, { maxCallsPerSession: 2 })
			await capped.create(OTHER, row(1))
			for (let n = 2; n <= 5; n++) await capped.create(SESSION, row(n))

			expect((await capped.list(OTHER, { limit: 100, offset: 0 })).total).toBe(1)
			expect((await capped.list(SESSION, { limit: 100, offset: 0 })).total).toBe(2)
		})

		test('keeps everything when the cap is off', async () => {
			const uncapped = new SqliteLLMCallLog(storage, { maxCallsPerSession: 0 })
			for (let n = 1; n <= 6; n++) await uncapped.create(SESSION, row(n))

			expect((await uncapped.list(SESSION, { limit: 100, offset: 0 })).total).toBe(6)
		})
	})

	test('declares the Durable Object column ceiling, so the caller clamps to it', () => {
		expect(log.maxBlobBytes).toBe(2_199_994)
	})
})
