/**
 * The LLM call log as rows in a Durable Object's SQLite rather than one JSON file per call.
 *
 * A call is ~17 KB — system prompt, message history and every tool's JSON schema
 * — and a turn makes four of them. As files that is 8 whole-file writes and 4
 * reads per turn, because `completeCall` reads the entry back to rewrite it, and
 * `listCalls` is a `readdir` plus one read per row of the page. See
 * `packages/computer-worker/README.md`, `/limits/fs-traffic`.
 *
 * Two things the layout is for:
 *
 * - **`completeCall` is an `UPDATE`, not a read-modify-write.** Response, metrics
 *   and error are their own columns, so finishing a call writes a few hundred
 *   bytes and never touches the request beside it. One entry blob would have kept
 *   the rewrite and only moved it off the VFS.
 * - **`listCalls` is `ORDER BY … LIMIT`.** `call_id` is UUIDv7, so the index gives
 *   the same newest-first order the sorted `readdir` did, and paging walks the
 *   index instead of the blobs.
 *
 * A rowid table, unlike `SqliteSessionLog`. `WITHOUT ROWID` keeps the whole
 * row in the index b-tree, which SQLite wants only for rows well under a page; a
 * 17 KB request is three orders past that. Here the blobs sit in the table and
 * the paging index stays small.
 */

import type { LLMCallOutcome, LLMCallPage, LLMCallRow, LLMCallStatus, LLMCallStore } from '@roj-ai/sdk/platform'
import type { SqlStorageHost } from './sqlite-event-store.js'

const CALLS_TABLE = 'roj_llm_call'

/**
 * Largest value a Durable Object will store in one column, measured — see
 * `/limits/payload`. `LLMLogger` clamps the request against it, because the
 * message history inside a request has no bound of its own.
 */
const MAX_COLUMN_BYTES = 2_199_994

/**
 * Calls kept per session before the oldest are dropped.
 *
 * The file host keeps every call forever and a Durable Object cannot: its SQLite
 * is shared by every session the object ever ran, a session need never close, and
 * the request blob grows with the conversation, so an uncapped table is superlinear
 * in turns. 200 is ~50 turns of complete request/response audit at four inferences
 * a turn — enough to debug the run you are looking at, bounded for the object that
 * holds it. Raise it where audit depth matters more than storage.
 */
const DEFAULT_MAX_CALLS_PER_SESSION = 200

export interface SqliteLLMCallLogOptions {
	/** Calls retained per session. Default 200; `0` keeps every call. */
	maxCallsPerSession?: number
}

/** Columns as SQLite hands them back: absent values are `null`, not `undefined`. */
interface CallRecord {
	call_id: string
	agent_id: string
	created_at: number
	status: string
	model: string
	request: string
	completed_at: number | null
	duration_ms: number | null
	provider_request_id: string | null
	response: string | null
	metrics: string | null
	error: string | null
}

const COLUMNS =
	'call_id, agent_id, created_at, status, model, request, completed_at, duration_ms, provider_request_id, response, metrics, error'

/** Only these three are ever written; anything else in the column is corruption. */
function toStatus(value: string): LLMCallStatus {
	if (value === 'running' || value === 'success' || value === 'error') return value
	return 'error'
}

function optional<T>(value: T | null): T | undefined {
	return value === null ? undefined : value
}

function toRow(record: CallRecord): LLMCallRow {
	return {
		callId: record.call_id,
		agentId: record.agent_id,
		createdAt: record.created_at,
		status: toStatus(record.status),
		model: record.model,
		request: record.request,
		completedAt: optional(record.completed_at),
		durationMs: optional(record.duration_ms),
		providerRequestId: optional(record.provider_request_id),
		response: optional(record.response),
		metrics: optional(record.metrics),
		error: optional(record.error),
	}
}

export class SqliteLLMCallLog implements LLMCallStore {
	readonly maxBlobBytes = MAX_COLUMN_BYTES

	private readonly maxCallsPerSession: number

	constructor(private readonly storage: SqlStorageHost, options: SqliteLLMCallLogOptions = {}) {
		this.maxCallsPerSession = options.maxCallsPerSession ?? DEFAULT_MAX_CALLS_PER_SESSION
		this.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${CALLS_TABLE} (
				session_id TEXT NOT NULL,
				call_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				status TEXT NOT NULL,
				model TEXT NOT NULL,
				request TEXT NOT NULL,
				completed_at INTEGER,
				duration_ms INTEGER,
				provider_request_id TEXT,
				response TEXT,
				metrics TEXT,
				error TEXT
			)`,
		)
		// Serves the key lookup, the ordered page and the retention trim alike:
		// call_id is UUIDv7, so descending on it is descending on time.
		this.storage.sql.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS ${CALLS_TABLE}_by_id ON ${CALLS_TABLE} (session_id, call_id)`,
		)
	}

	async create(sessionId: string, row: LLMCallRow): Promise<void> {
		this.storage.sql.exec(
			`INSERT INTO ${CALLS_TABLE} (session_id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			sessionId,
			row.callId,
			row.agentId,
			row.createdAt,
			row.status,
			row.model,
			row.request,
			row.completedAt ?? null,
			row.durationMs ?? null,
			row.providerRequestId ?? null,
			row.response ?? null,
			row.metrics ?? null,
			row.error ?? null,
		)
		this.trim(sessionId)
	}

	async complete(sessionId: string, callId: string, outcome: LLMCallOutcome): Promise<void> {
		// No SELECT and no request column in the SET list — the point of the split.
		// A call the trim or a reap already removed simply matches no row.
		this.storage.sql.exec(
			`UPDATE ${CALLS_TABLE}
				SET status = ?, completed_at = ?, duration_ms = ?, provider_request_id = ?, response = ?, metrics = ?, error = ?
				WHERE session_id = ? AND call_id = ?`,
			outcome.status,
			outcome.completedAt,
			outcome.durationMs,
			outcome.providerRequestId ?? null,
			outcome.response ?? null,
			outcome.metrics ?? null,
			outcome.error ?? null,
			sessionId,
			callId,
		)
	}

	async get(sessionId: string, callId: string): Promise<LLMCallRow | null> {
		const records = this.storage.sql
			.exec<CallRecord>(`SELECT ${COLUMNS} FROM ${CALLS_TABLE} WHERE session_id = ? AND call_id = ?`, sessionId, callId)
			.toArray()

		const record = records[0]
		return record === undefined ? null : toRow(record)
	}

	async list(sessionId: string, options: { limit: number; offset: number }): Promise<LLMCallPage> {
		const records = this.storage.sql
			.exec<CallRecord>(
				`SELECT ${COLUMNS} FROM ${CALLS_TABLE} WHERE session_id = ? ORDER BY call_id DESC LIMIT ? OFFSET ?`,
				sessionId,
				options.limit,
				options.offset,
			)
			.toArray()

		return { calls: records.map(toRow), total: this.count(sessionId) }
	}

	async delete(sessionId: string): Promise<number> {
		const calls = this.count(sessionId)
		// SQLite frees the pages but does not shrink the file, so databaseSize holds.
		this.storage.sql.exec(`DELETE FROM ${CALLS_TABLE} WHERE session_id = ?`, sessionId)
		return calls
	}

	/**
	 * Drop everything older than the newest `maxCallsPerSession`.
	 *
	 * One statement: the subquery walks the index to the cut-off call and the
	 * delete takes what sorts below it. When the session holds fewer calls than
	 * the cap the subquery is NULL, `call_id < NULL` is NULL, and nothing goes.
	 */
	private trim(sessionId: string): void {
		if (this.maxCallsPerSession <= 0) return
		this.storage.sql.exec(
			`DELETE FROM ${CALLS_TABLE}
				WHERE session_id = ?
				AND call_id < (SELECT call_id FROM ${CALLS_TABLE} WHERE session_id = ? ORDER BY call_id DESC LIMIT 1 OFFSET ?)`,
			sessionId,
			sessionId,
			this.maxCallsPerSession - 1,
		)
	}

	private count(sessionId: string): number {
		const rows = this.storage.sql
			.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${CALLS_TABLE} WHERE session_id = ?`, sessionId)
			.toArray()

		return rows[0]?.count ?? 0
	}
}
