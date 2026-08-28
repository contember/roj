/**
 * `bun:sqlite` standing in for Durable Object SQL storage, so the adapter can
 * be driven by `bun test` without a Worker runtime.
 *
 * It is deliberately *stricter* than its backing engine on one point. A Durable
 * Object binds at most 100 parameters per statement; bun:sqlite binds far more,
 * and an earlier attempt at this port shipped a batch insert that passed every
 * test and failed in production for exactly that reason. A fake that is more
 * permissive than the thing it stands for hides the bugs worth catching, so the
 * limit is enforced here rather than discovered on a deploy.
 */

import { Database as BunDatabase, type SQLQueryBindings } from 'bun:sqlite'
import type { DurableObjectStorageLike, SQLCursorLike, SQLStorageLike } from 'kompjutr'

/** What a Durable Object binds per statement. The 101st raises, as workerd does. */
export const MAX_BIND_PARAMETERS = 100

/** SQLite takes bytes, numbers, strings and null; everything else is converted or refused. */
function toBinding(value: unknown): SQLQueryBindings {
	if (value === undefined || value === null) return null
	if (typeof value === 'boolean') return value ? 1 : 0
	if (value instanceof ArrayBuffer) return new Uint8Array(value)
	if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
	}
	if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' || value instanceof Uint8Array) {
		return value
	}
	throw new TypeError(`unsupported SQLite binding: ${typeof value}`)
}

/**
 * Rows arrive lazily, because `Filesystem.scan` pages a range scan and a cursor
 * that materialised would turn every page into the whole table.
 *
 * One step is taken up front all the same: a statement nobody iterates is a
 * statement bun:sqlite never runs, and a `CREATE TABLE` has no rows to pull.
 */
class Cursor<Row extends object> implements SQLCursorLike<Row>, IterableIterator<Row> {
	#rows: Iterator<Row>
	#prefetched: IteratorResult<Row> | null
	#done = false

	constructor(rows: Iterator<Row>, private readonly onRow: () => void) {
		this.#rows = rows
		this.#prefetched = this.#pull()
	}

	#pull(): IteratorResult<Row> {
		const step = this.#rows.next()
		if (step.done === true) this.#done = true
		else this.onRow()
		return step
	}

	next(): IteratorResult<Row> {
		if (this.#prefetched !== null) {
			const first = this.#prefetched
			this.#prefetched = null
			return first
		}
		if (this.#done) return { done: true, value: undefined }
		return this.#pull()
	}

	return(): IteratorResult<Row> {
		if (!this.#done) {
			this.#rows.return?.()
			this.#done = true
		}
		this.#prefetched = null
		return { done: true, value: undefined }
	}

	[Symbol.iterator](): IterableIterator<Row> {
		return this
	}

	toArray(): Row[] {
		return Array.from(this)
	}
}

export class BunSqliteStorage implements DurableObjectStorageLike {
	readonly db: BunDatabase
	readonly sql: SQLStorageLike

	/** Statements executed since the last reset — what a cost test asserts on. */
	statementCount = 0
	/** Rows the caller actually pulled. Approximate: a cursor abandoned early stops counting. */
	rowCount = 0

	#depth = 0

	constructor(path = ':memory:') {
		this.db = new BunDatabase(path, { create: true })
		this.db.run('PRAGMA journal_mode = WAL')
		this.sql = {
			exec: <Row extends object>(query: string, ...bindings: unknown[]): SQLCursorLike<Row> => {
				if (bindings.length > MAX_BIND_PARAMETERS) {
					throw new Error(`too many SQL variables: ${bindings.length} exceeds the ${MAX_BIND_PARAMETERS} a Durable Object binds`)
				}
				this.statementCount++
				const statement = this.db.query<Row, SQLQueryBindings[]>(query)
				const rows = statement.iterate(...bindings.map(toBinding))
				return new Cursor<Row>(rows, () => {
					this.rowCount++
				})
			},
		}
	}

	transactionSync<T>(closure: () => T): T {
		if (this.#depth > 0) return closure()
		this.#depth++
		this.db.run('BEGIN')
		try {
			const result = closure()
			this.db.run('COMMIT')
			return result
		} catch (error) {
			this.db.run('ROLLBACK')
			throw error
		} finally {
			this.#depth--
		}
	}

	resetCounters(): void {
		this.statementCount = 0
		this.rowCount = 0
	}

	close(): void {
		this.db.close()
	}
}
