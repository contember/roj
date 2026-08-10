import { Database } from 'bun:sqlite'
import type { SQLQueryBindings } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { SqlCursorLike, SqlStorageHost, SqlStorageLike } from './sqlite-event-store.js'
import { SqliteSessionLog } from './sqlite-session-log.js'

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

	/** Fault injection, so a failed insert can be exercised without breaking the schema. */
	failOn: ((query: string) => boolean) | null = null

	readonly sql: SqlStorageLike = {
		exec: <Row extends object>(query: string, ...bindings: unknown[]): SqlCursorLike<Row> => {
			if (this.failOn?.(query)) throw new Error('injected SQL failure')
			const rows = this.db.query<Row, SQLQueryBindings[]>(query).all(...bindings.map(toBinding))
			return { toArray: () => rows }
		},
	}
}

const SESSION = '01900000-0000-7000-8000-000000000001'
const OTHER = '01900000-0000-7000-8000-000000000002'

const line = (n: number) => JSON.stringify({ level: 'debug', message: `line ${n}` })

describe('SqliteSessionLog', () => {
	let storage: FakeSqlStorage
	let log: SqliteSessionLog

	beforeEach(() => {
		storage = new FakeSqlStorage()
		log = new SqliteSessionLog(storage)
	})

	test('reads back every line from the default cursor', async () => {
		log.append(SESSION, line(1))
		log.append(SESSION, line(2))

		expect(await log.read(SESSION, 0)).toEqual({ lines: [line(1), line(2)], offset: 2 })
	})

	test('returns only what arrived after the cursor it was given', async () => {
		log.append(SESSION, line(1))
		const first = await log.read(SESSION, 0)

		log.append(SESSION, line(2))

		expect(await log.read(SESSION, first.offset)).toEqual({ lines: [line(2)], offset: 2 })
	})

	test('holds the cursor when nothing new arrived', async () => {
		log.append(SESSION, line(1))

		expect(await log.read(SESSION, 1)).toEqual({ lines: [], offset: 1 })
	})

	test('rewinds a cursor left past the end instead of sticking', async () => {
		log.append(SESSION, line(1))

		expect(await log.read(SESSION, 99)).toEqual({ lines: [], offset: 1 })
	})

	test('reads empty for a session that never logged', async () => {
		expect(await log.read(SESSION, 0)).toEqual({ lines: [], offset: 0 })
	})

	test('keeps sessions apart', async () => {
		log.append(SESSION, line(1))
		log.append(OTHER, line(2))
		log.append(SESSION, line(3))

		expect((await log.read(SESSION, 0)).lines).toEqual([line(1), line(3)])
		expect((await log.read(OTHER, 0)).lines).toEqual([line(2)])
	})

	test('continues the sequence after a restart, so a poller keeps its cursor', async () => {
		log.append(SESSION, line(1))
		log.append(SESSION, line(2))

		// A second instance over the same storage is what an evicted isolate coming back is.
		const reopened = new SqliteSessionLog(storage)
		reopened.append(SESSION, line(3))

		expect(await reopened.read(SESSION, 2)).toEqual({ lines: [line(3)], offset: 3 })
	})

	test('drops a line rather than throwing at the logger', async () => {
		log.append(SESSION, line(1))
		storage.failOn = (query) => query.startsWith('INSERT')

		expect(() => log.append(SESSION, line(2))).not.toThrow()

		storage.failOn = null
		expect((await log.read(SESSION, 0)).lines).toEqual([line(1)])
	})

	test('delete reports what went and leaves other sessions alone', async () => {
		log.append(SESSION, line(1))
		log.append(SESSION, line(2))
		log.append(OTHER, line(3))

		expect(await log.delete(SESSION)).toBe(2)
		expect(await log.read(SESSION, 0)).toEqual({ lines: [], offset: 0 })
		expect((await log.read(OTHER, 0)).lines).toEqual([line(3)])
	})

	test('delete of a session that never logged reports nothing', async () => {
		expect(await log.delete(SESSION)).toBe(0)
	})

	test('restarts the sequence after a delete, so reclaimed rows are not re-counted', async () => {
		log.append(SESSION, line(1))
		await log.delete(SESSION)

		log.append(SESSION, line(2))

		expect(await log.read(SESSION, 0)).toEqual({ lines: [line(2)], offset: 1 })
	})
})
