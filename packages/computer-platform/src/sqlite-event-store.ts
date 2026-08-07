/**
 * EventStore backed by a Durable Object's SQLite rather than the workspace filesystem.
 *
 * `FileEventStore` rewrites a JSONL blob through the VFS on every append and parses
 * the whole file on every load. One row per event turns append into an insert and
 * `loadRange` into a seek down the clustered `(session_id, seq)` key.
 */

import { BaseEventStore, EventAppendError, EventStoreError, isDomainEvent, SessionId } from '@roj-ai/sdk'
import type { DomainEvent, LoadRangeOptions, LoadRangeResult, SessionMetadata } from '@roj-ai/sdk'

export interface SqlCursorLike<Row extends object> {
	toArray(): Row[]
}

export interface SqlStorageLike {
	exec<Row extends object>(query: string, ...bindings: unknown[]): SqlCursorLike<Row>
}

/**
 * The SQL surface of a Durable Object, structurally the same as `@cloudflare/computer`'s
 * `DurableObjectStorageLike`. Declared here so any SQLite host can back the store.
 */
export interface SqlStorageHost {
	sql: SqlStorageLike
}

const EVENTS_TABLE = 'roj_events'
const METADATA_TABLE = 'roj_session_metadata'

/** `seq` is the 0-based event index the EventStore contract reports as fromIndex/toIndex. */
interface EventRow {
	seq: number
	payload: string
}

interface MetadataRow {
	session_id: string
	metadata: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStatus(value: unknown): value is SessionMetadata['status'] {
	return value === 'active' || value === 'closed' || value === 'errored'
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined
}

function optionalStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined
	const items: string[] = []
	for (const item of value) {
		if (typeof item !== 'string') return undefined
		items.push(item)
	}
	return items
}

function toMetrics(value: unknown): SessionMetadata['metrics'] {
	if (!isRecord(value)) return undefined

	const totalEvents = optionalNumber(value.totalEvents)
	const totalAgents = optionalNumber(value.totalAgents)
	const totalTokens = optionalNumber(value.totalTokens)
	const totalLLMCalls = optionalNumber(value.totalLLMCalls)
	if (
		totalEvents === undefined || totalAgents === undefined
		|| totalTokens === undefined || totalLLMCalls === undefined
	) {
		return undefined
	}

	return {
		totalEvents,
		totalAgents,
		totalTokens,
		totalLLMCalls,
		inputTokens: optionalNumber(value.inputTokens),
		outputTokens: optionalNumber(value.outputTokens),
		totalCost: optionalNumber(value.totalCost),
		totalMessages: optionalNumber(value.totalMessages),
		totalToolCalls: optionalNumber(value.totalToolCalls),
	}
}

/**
 * Rebuild metadata from a stored blob.
 *
 * Defaults stand in for missing scalars because `BaseEventStore.updateMetadata`
 * writes whatever partial it has — a session whose first event is not
 * `session_created` has no presetId, createdAt or status yet.
 */
function toSessionMetadata(value: unknown): SessionMetadata | null {
	if (!isRecord(value)) return null

	const sessionId = typeof value.sessionId === 'string' ? value.sessionId : undefined
	if (sessionId === undefined) return null

	return {
		sessionId: SessionId(sessionId),
		presetId: typeof value.presetId === 'string' ? value.presetId : '',
		createdAt: optionalNumber(value.createdAt) ?? 0,
		lastActivityAt: optionalNumber(value.lastActivityAt) ?? 0,
		status: isStatus(value.status) ? value.status : 'active',
		name: typeof value.name === 'string' ? value.name : undefined,
		tags: optionalStringArray(value.tags),
		metrics: toMetrics(value.metrics),
		custom: isRecord(value.custom) ? value.custom : undefined,
	}
}

export class SqliteEventStore extends BaseEventStore {
	/** Tail of the append chain per session; see appendSerialized. */
	private readonly appendTails = new Map<SessionId, Promise<void>>()

	constructor(private readonly storage: SqlStorageHost) {
		super()

		// WITHOUT ROWID stores rows in primary-key order, so a session's events are
		// contiguous and loadRange never leaves the index.
		this.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
				session_id TEXT NOT NULL,
				seq INTEGER NOT NULL,
				payload TEXT NOT NULL,
				PRIMARY KEY (session_id, seq)
			) WITHOUT ROWID`,
		)
		this.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${METADATA_TABLE} (
				session_id TEXT PRIMARY KEY,
				metadata TEXT NOT NULL
			)`,
		)
	}

	// =========================================================================
	// Event storage primitives
	// =========================================================================

	protected async doAppend(sessionId: SessionId, event: DomainEvent): Promise<void> {
		await this.doAppendBatch(sessionId, [event])
	}

	protected async doAppendBatch(sessionId: SessionId, events: DomainEvent[]): Promise<void> {
		if (events.length === 0) return

		await this.appendSerialized(sessionId, async () => {
			try {
				// exec is synchronous, so claiming the sequence and inserting cannot interleave.
				const firstSeq = this.lastSeq(sessionId) + 1
				const tuples = events.map(() => '(?, ?, ?)').join(', ')
				const bindings = events.flatMap((event, offset) => [sessionId, firstSeq + offset, JSON.stringify(event)])

				// One statement, so a batch lands whole or not at all.
				this.storage.sql.exec(`INSERT INTO ${EVENTS_TABLE} (session_id, seq, payload) VALUES ${tuples}`, ...bindings)

				await this.updateMetadataFromEvents(sessionId, events)
			} catch (error) {
				throw new EventAppendError(sessionId, error)
			}
		})
	}

	async load(sessionId: SessionId): Promise<DomainEvent[]> {
		const rows = this.storage.sql
			.exec<EventRow>(`SELECT seq, payload FROM ${EVENTS_TABLE} WHERE session_id = ? ORDER BY seq`, sessionId)
			.toArray()

		return rows.map((row) => this.decodeEvent(sessionId, row))
	}

	async loadRange(sessionId: SessionId, options?: LoadRangeOptions): Promise<LoadRangeResult> {
		const since = options?.since ?? -1
		const limit = options?.limit

		// SQLite reads a negative limit as unlimited, so clamp rather than inherit that.
		const rows = this.storage.sql
			.exec<EventRow>(
				`SELECT seq, payload FROM ${EVENTS_TABLE} WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
				sessionId,
				since,
				limit === undefined ? -1 : Math.max(limit, 0),
			)
			.toArray()

		const first = rows[0]
		const last = rows[rows.length - 1]
		if (first === undefined || last === undefined) {
			// Report the store's last index instead, so a poller keeps its cursor.
			return { events: [], fromIndex: -1, toIndex: this.lastSeq(sessionId) }
		}

		return {
			events: rows.map((row) => this.decodeEvent(sessionId, row)),
			fromIndex: first.seq,
			toIndex: last.seq,
		}
	}

	async exists(sessionId: SessionId): Promise<boolean> {
		const rows = this.storage.sql
			.exec<{ found: number }>(`SELECT 1 AS found FROM ${EVENTS_TABLE} WHERE session_id = ? LIMIT 1`, sessionId)
			.toArray()

		return rows.length > 0
	}

	async listSessions(): Promise<SessionId[]> {
		// A session created by updateMetadata alone has no events yet, and FileEventStore lists it.
		const rows = this.storage.sql
			.exec<{ session_id: string }>(
				`SELECT session_id FROM ${EVENTS_TABLE}
				UNION
				SELECT session_id FROM ${METADATA_TABLE}
				ORDER BY session_id`,
			)
			.toArray()

		return rows.map((row) => SessionId(row.session_id))
	}

	// =========================================================================
	// Metadata storage primitives
	// =========================================================================

	protected async readMetadata(sessionId: SessionId): Promise<SessionMetadata | null> {
		const rows = this.storage.sql
			.exec<{ metadata: string }>(`SELECT metadata FROM ${METADATA_TABLE} WHERE session_id = ?`, sessionId)
			.toArray()

		const row = rows[0]
		return row === undefined ? null : this.decodeMetadata(sessionId, row.metadata)
	}

	protected async writeMetadata(sessionId: SessionId, metadata: SessionMetadata): Promise<void> {
		this.storage.sql.exec(
			`INSERT INTO ${METADATA_TABLE} (session_id, metadata) VALUES (?, ?)
			ON CONFLICT(session_id) DO UPDATE SET metadata = excluded.metadata`,
			sessionId,
			JSON.stringify(metadata),
		)
	}

	protected async getAllSessionMetadata(): Promise<SessionMetadata[]> {
		const rows = this.storage.sql
			.exec<MetadataRow>(`SELECT session_id, metadata FROM ${METADATA_TABLE} ORDER BY session_id`)
			.toArray()

		return rows.map((row) => this.decodeMetadata(SessionId(row.session_id), row.metadata))
	}

	// =========================================================================
	// Internals
	// =========================================================================

	/** Index of the last stored event, -1 when the session has none. */
	private lastSeq(sessionId: SessionId): number {
		const rows = this.storage.sql
			.exec<{ max_seq: number | null }>(`SELECT MAX(seq) AS max_seq FROM ${EVENTS_TABLE} WHERE session_id = ?`, sessionId)
			.toArray()

		return rows[0]?.max_seq ?? -1
	}

	/**
	 * Run appends for one session one at a time.
	 *
	 * The SQL is synchronous but the metadata update that follows it is not, so
	 * concurrent appends would otherwise read-modify-write the same metrics.
	 */
	private appendSerialized(sessionId: SessionId, task: () => Promise<void>): Promise<void> {
		const previous = this.appendTails.get(sessionId) ?? Promise.resolve()
		const next = previous.then(task)
		// The stored tail must never reject, or the next append inherits this one's failure.
		this.appendTails.set(sessionId, next.catch(() => undefined))
		return next
	}

	private decodeEvent(sessionId: SessionId, row: EventRow): DomainEvent {
		let parsed: unknown
		try {
			parsed = JSON.parse(row.payload)
		} catch (error) {
			throw new EventStoreError(`Failed to parse event at index ${row.seq}`, sessionId, error)
		}

		if (!isDomainEvent(parsed)) {
			throw new EventStoreError(`Failed to parse event at index ${row.seq}`, sessionId)
		}
		return parsed
	}

	private decodeMetadata(sessionId: SessionId, raw: string): SessionMetadata {
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch (error) {
			throw new EventStoreError('Failed to parse session metadata', sessionId, error)
		}

		const metadata = toSessionMetadata(parsed)
		if (metadata === null) {
			throw new EventStoreError('Failed to parse session metadata', sessionId)
		}
		return metadata
	}
}
