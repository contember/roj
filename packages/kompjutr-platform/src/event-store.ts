/**
 * `EventStore` over the workspace's own SQLite rather than a JSONL file in it.
 *
 * The file store rewrites a blob through the filesystem on every append and
 * parses the whole file on every load. One row per event turns an append into
 * an insert and `loadRange` into a seek down the clustered `(session_id, seq)`
 * key. This is the write path an event-sourced session spends its day on.
 */

import { BaseEventStore, EventAppendError, EventStoreError, isDomainEvent, SessionId, sessionMetadataSchema } from '@roj-ai/sdk'
import type { DomainEvent, LoadRangeOptions, LoadRangeResult, Logger, SessionMetadata } from '@roj-ai/sdk'
import type { SqlDatabase } from 'kompjutr'

const EVENTS_TABLE = 'roj_events'
const METADATA_TABLE = 'roj_session_metadata'

/** A Durable Object binds at most 100 parameters per statement, and a row costs three. */
const EVENTS_PER_INSERT = 33

/** `seq` is the 0-based event index the contract reports as fromIndex/toIndex. */
interface EventRow {
	seq: number
	payload: string
}

export class KompjutrEventStore extends BaseEventStore {
	/** Tail of the append chain per session; see #serialized. */
	readonly #appendTails = new Map<SessionId, Promise<void>>()

	constructor(private readonly db: SqlDatabase, private readonly logger?: Logger) {
		super()

		// WITHOUT ROWID stores rows in primary-key order, so a session's events are
		// contiguous and loadRange never leaves the index.
		this.db.run(
			`CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
				session_id TEXT NOT NULL,
				seq INTEGER NOT NULL,
				payload TEXT NOT NULL,
				PRIMARY KEY (session_id, seq)
			) WITHOUT ROWID`,
		)
		this.db.run(
			`CREATE TABLE IF NOT EXISTS ${METADATA_TABLE} (
				session_id TEXT PRIMARY KEY,
				metadata TEXT NOT NULL
			)`,
		)
	}

	protected async doAppend(sessionId: SessionId, event: DomainEvent): Promise<void> {
		await this.doAppendBatch(sessionId, [event])
	}

	protected async doAppendBatch(sessionId: SessionId, events: DomainEvent[]): Promise<void> {
		if (events.length === 0) return

		await this.#serialized(sessionId, async () => {
			try {
				// One transaction, so a batch too wide for a single statement still
				// lands whole. The old shape relied on the host committing a
				// synchronous run together, which only a Durable Object promises.
				this.db.transactionSync(() => {
					const firstSeq = this.#lastSeq(sessionId) + 1
					for (let offset = 0; offset < events.length; offset += EVENTS_PER_INSERT) {
						const chunk = events.slice(offset, offset + EVENTS_PER_INSERT)
						const tuples = chunk.map(() => '(?, ?, ?)').join(', ')
						const bindings = chunk.flatMap((event, index) => [sessionId, firstSeq + offset + index, JSON.stringify(event)])
						this.db.run(`INSERT INTO ${EVENTS_TABLE} (session_id, seq, payload) VALUES ${tuples}`, ...bindings)
					}
				})

				await this.updateMetadataFromEvents(sessionId, events)
			} catch (error) {
				throw new EventAppendError(sessionId, error)
			}
		})
	}

	async load(sessionId: SessionId): Promise<DomainEvent[]> {
		const rows = this.db.all<EventRow>(`SELECT seq, payload FROM ${EVENTS_TABLE} WHERE session_id = ? ORDER BY seq`, sessionId)
		return rows.map((row) => this.#decodeEvent(sessionId, row))
	}

	async loadRange(sessionId: SessionId, options?: LoadRangeOptions): Promise<LoadRangeResult> {
		const since = options?.since ?? -1
		const limit = options?.limit

		const rows = this.db.all<EventRow>(
			`SELECT seq, payload FROM ${EVENTS_TABLE} WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
			sessionId,
			since,
			// SQLite reads a negative limit as unlimited; clamp rather than inherit that.
			limit === undefined ? -1 : Math.max(limit, 0),
		)

		const first = rows[0]
		const last = rows[rows.length - 1]
		if (first === undefined || last === undefined) {
			// Report the store's last index instead, so a poller keeps its cursor.
			return { events: [], fromIndex: -1, toIndex: this.#lastSeq(sessionId) }
		}

		return {
			events: rows.map((row) => this.#decodeEvent(sessionId, row)),
			fromIndex: first.seq,
			toIndex: last.seq,
		}
	}

	async exists(sessionId: SessionId): Promise<boolean> {
		return this.db.one(`SELECT 1 FROM ${EVENTS_TABLE} WHERE session_id = ? LIMIT 1`, sessionId) !== undefined
	}

	/**
	 * Every session this store holds, from either side of the pair.
	 *
	 * Neither side implies the other. A session created by `updateMetadata` alone
	 * has no events yet and the file store still lists it; a session whose
	 * metadata write failed after its rows landed has events and no metadata, and
	 * then the log is the only record it ran. So the answer is a union — taken
	 * without reading the log, because a status poll counts these.
	 *
	 * The recursive term seeks from one distinct id straight to the next down the
	 * `(session_id, seq)` primary key, so the cost follows sessions rather than
	 * events. `SELECT DISTINCT session_id` reads every row instead.
	 */
	async listSessions(): Promise<SessionId[]> {
		const rows = this.db.all<{ session_id: string }>(
			`WITH RECURSIVE event_sessions(session_id) AS (
				SELECT MIN(session_id) FROM ${EVENTS_TABLE}
				UNION ALL
				SELECT (SELECT MIN(session_id) FROM ${EVENTS_TABLE} WHERE session_id > previous.session_id)
				FROM event_sessions AS previous
				WHERE previous.session_id IS NOT NULL
			)
			SELECT session_id FROM event_sessions WHERE session_id IS NOT NULL
			UNION
			SELECT session_id FROM ${METADATA_TABLE}
			ORDER BY session_id`,
		)

		return rows.map((row) => SessionId(row.session_id))
	}

	/**
	 * Drop every row this store holds for one session, and report how many events went.
	 *
	 * Deliberately outside the `EventStore` contract: the log is the only record
	 * that a session existed, so nothing in the SDK can reach this by accident.
	 * Whether a session may be dropped is the caller's policy.
	 */
	async deleteSession(sessionId: SessionId): Promise<number> {
		let events = 0

		// Serialized with appends, so a delete cannot land between a batch's
		// sequence claim and its inserts and leave the tail of that batch behind.
		await this.#serialized(sessionId, async () => {
			this.db.transactionSync(() => {
				events = this.db.scalar<number>(`SELECT COUNT(*) FROM ${EVENTS_TABLE} WHERE session_id = ?`, sessionId) ?? 0
				this.db.run(`DELETE FROM ${EVENTS_TABLE} WHERE session_id = ?`, sessionId)
				this.db.run(`DELETE FROM ${METADATA_TABLE} WHERE session_id = ?`, sessionId)
			})
		})

		// The chain's tail is per-session state; a deleted session must not keep one.
		this.#appendTails.delete(sessionId)
		return events
	}

	protected async readMetadata(sessionId: SessionId): Promise<SessionMetadata | null> {
		const row = this.db.one<{ metadata: string }>(`SELECT metadata FROM ${METADATA_TABLE} WHERE session_id = ?`, sessionId)
		return row === undefined ? null : this.#decodeMetadata(sessionId, row.metadata)
	}

	/** A session whose metadata does not parse is skipped, never thrown over. */
	#skip(sessionId: SessionId, reason: string): null {
		this.logger?.warn('Skipping invalid session metadata', { sessionId, reason })
		return null
	}

	protected async writeMetadata(sessionId: SessionId, metadata: SessionMetadata): Promise<void> {
		this.db.run(
			`INSERT INTO ${METADATA_TABLE} (session_id, metadata) VALUES (?, ?)
			ON CONFLICT(session_id) DO UPDATE SET metadata = excluded.metadata`,
			sessionId,
			JSON.stringify(metadata),
		)
	}

	protected async getAllSessionMetadata(): Promise<SessionMetadata[]> {
		const rows = this.db.all<{ session_id: string; metadata: string }>(
			`SELECT session_id, metadata FROM ${METADATA_TABLE} ORDER BY session_id`,
		)
		return rows
			.map((row) => this.#decodeMetadata(SessionId(row.session_id), row.metadata))
			.filter((metadata): metadata is SessionMetadata => metadata !== null)
	}

	/** Index of the last stored event, -1 when the session has none. */
	#lastSeq(sessionId: SessionId): number {
		return this.db.scalar<number | null>(`SELECT MAX(seq) FROM ${EVENTS_TABLE} WHERE session_id = ?`, sessionId) ?? -1
	}

	/**
	 * Run appends for one session one at a time.
	 *
	 * The SQL is synchronous but the metadata update that follows it is not, so
	 * concurrent appends would otherwise read-modify-write the same metrics.
	 */
	#serialized(sessionId: SessionId, task: () => Promise<void>): Promise<void> {
		const previous = this.#appendTails.get(sessionId) ?? Promise.resolve()
		const next = previous.then(task)
		// The stored tail must never reject, or the next append inherits this failure.
		this.#appendTails.set(sessionId, next.catch(() => undefined))
		return next
	}

	#decodeEvent(sessionId: SessionId, row: EventRow): DomainEvent {
		let parsed: unknown
		try {
			parsed = JSON.parse(row.payload)
		} catch (error) {
			throw new EventStoreError(`Failed to parse event at index ${row.seq}`, sessionId, error)
		}

		if (!isDomainEvent(parsed)) throw new EventStoreError(`Failed to parse event at index ${row.seq}`, sessionId)
		return parsed
	}

	/**
	 * Null rather than a throw, matching `FileEventStore`: one unreadable row must
	 * not take out the listing every other session appears in.
	 */
	#decodeMetadata(sessionId: SessionId, raw: string): SessionMetadata | null {
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch (error) {
			return this.#skip(sessionId, String(error))
		}

		const result = sessionMetadataSchema.safeParse(parsed)
		return result.success ? result.data : this.#skip(sessionId, result.error.message)
	}
}
