/**
 * The LLM call log as rows rather than one JSON file per call.
 *
 * A call carries the system prompt, the message history and every tool's JSON
 * schema, and a turn makes several. As files that is two whole-file writes per
 * call — `completeCall` reads the entry back to rewrite it — and a listing is a
 * directory read plus one file read per row of the page.
 *
 * Two things the layout is for:
 *
 * - **`complete` is an `UPDATE`, not a read-modify-write.** Response, metrics
 *   and error are their own columns, so finishing a call writes a few hundred
 *   bytes and never touches the request beside it. One entry blob would have
 *   kept the rewrite and only moved it off the filesystem.
 * - **`list` is `ORDER BY … LIMIT`.** `call_id` is UUIDv7 — fixed width,
 *   lowercase hex, time-ordered — so its lexicographic order is its
 *   chronological one, and paging walks the index instead of the blobs.
 *
 * A rowid table, unlike the session log. `WITHOUT ROWID` keeps the whole row in
 * the index b-tree, which suits rows well under a page; a request is three
 * orders past that. Here the blobs sit in the table and the paging index stays
 * small.
 */

import type { LLMCallOutcome, LLMCallPage, LLMCallRow, LLMCallStatus, LLMCallStore } from '@roj-ai/sdk/platform'
import type { SqlDatabase } from '@kompjutr/do'

const CALLS_TABLE = 'roj_llm_call'

/**
 * Largest value a Durable Object stores in one column, measured. The caller
 * clamps a request against it, because the message history inside one has no
 * bound of its own and an oversized prompt must not turn a logged call into a
 * failed inference.
 */
const DURABLE_OBJECT_COLUMN_BYTES = 2_199_994

/**
 * Calls kept per session before the oldest go.
 *
 * A file host keeps every call forever and a shared database cannot: one
 * database serves every session the host ever ran, a session need never close,
 * and the request blob grows with the conversation, so an uncapped table is
 * superlinear in turns. 200 is roughly 50 turns of complete request and
 * response audit — enough to debug the run in front of you, bounded for the
 * object holding it. Raise it where audit depth matters more than storage.
 */
const DEFAULT_MAX_CALLS_PER_SESSION = 200

export interface KompjutrLLMCallLogOptions {
	/** Calls retained per session. Default 200; `0` keeps every call. */
	maxCallsPerSession?: number
	/**
	 * Column ceiling the caller clamps a request to. Defaults to a Durable
	 * Object's; a host with no ceiling passes `0`.
	 */
	maxBlobBytes?: number
}

/** Columns as SQLite hands them back: an absent value is `null`, not `undefined`. */
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

const COLUMNS = 'call_id, agent_id, created_at, status, model, request, completed_at, duration_ms, provider_request_id, response, metrics, error'

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

export class KompjutrLLMCallLog implements LLMCallStore {
	readonly maxBlobBytes: number | undefined
	readonly #maxCallsPerSession: number

	constructor(
		private readonly db: SqlDatabase,
		options: KompjutrLLMCallLogOptions = {},
	) {
		this.#maxCallsPerSession = options.maxCallsPerSession ?? DEFAULT_MAX_CALLS_PER_SESSION
		const ceiling = options.maxBlobBytes ?? DURABLE_OBJECT_COLUMN_BYTES
		this.maxBlobBytes = ceiling > 0 ? ceiling : undefined

		this.db.run(
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
		this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${CALLS_TABLE}_by_id ON ${CALLS_TABLE} (session_id, call_id)`)
	}

	async create(sessionId: string, row: LLMCallRow): Promise<void> {
		this.db.run(
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
		this.#trim(sessionId)
	}

	async complete(sessionId: string, callId: string, outcome: LLMCallOutcome): Promise<void> {
		// No SELECT and no request column in the SET list — the point of the split.
		// A call the trim or a reap already removed simply matches no row.
		this.db.run(
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
		const record = this.db.one<CallRecord>(`SELECT ${COLUMNS} FROM ${CALLS_TABLE} WHERE session_id = ? AND call_id = ?`, sessionId, callId)
		return record === undefined ? null : toRow(record)
	}

	async list(sessionId: string, options: { limit: number; offset: number }): Promise<LLMCallPage> {
		const records = this.db.all<CallRecord>(
			`SELECT ${COLUMNS} FROM ${CALLS_TABLE} WHERE session_id = ? ORDER BY call_id DESC LIMIT ? OFFSET ?`,
			sessionId,
			options.limit,
			options.offset,
		)
		return { calls: records.map(toRow), total: this.#count(sessionId) }
	}

	async delete(sessionId: string): Promise<number> {
		const calls = this.#count(sessionId)
		this.db.run(`DELETE FROM ${CALLS_TABLE} WHERE session_id = ?`, sessionId)
		return calls
	}

	/**
	 * Drop everything older than the newest `maxCallsPerSession`.
	 *
	 * One statement: the subquery walks the index to the cut-off call and the
	 * delete takes what sorts below it. Under the cap the subquery is NULL,
	 * `call_id < NULL` is NULL, and nothing goes.
	 */
	#trim(sessionId: string): void {
		if (this.#maxCallsPerSession <= 0) return
		this.db.run(
			`DELETE FROM ${CALLS_TABLE}
				WHERE session_id = ?
				AND call_id < (SELECT call_id FROM ${CALLS_TABLE} WHERE session_id = ? ORDER BY call_id DESC LIMIT 1 OFFSET ?)`,
			sessionId,
			sessionId,
			this.#maxCallsPerSession - 1,
		)
	}

	#count(sessionId: string): number {
		return this.db.scalar<number>(`SELECT COUNT(*) FROM ${CALLS_TABLE} WHERE session_id = ?`, sessionId) ?? 0
	}
}
