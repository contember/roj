import type { SqlDatabase } from '@kompjutr/do'
import type { LLMCallOutcome, LLMCallPage, LLMCallRow, LLMCallStatus, LLMCallStore } from '@roj-ai/sdk/platform'
import { LLMCallPayloads, storedNumber, storedString } from './llm-call-payloads.js'

const CALLS_TABLE = 'roj_llm_call'
const PAYLOAD_FORMAT = 1
const DEFAULT_MAX_CALLS_PER_SESSION = 200

export interface KompjutrLLMCallLogOptions {
	/** Calls retained per session. Default 200; `0` keeps every call. */
	maxCallsPerSession?: number
	/** Opt-in caller request clamp in UTF-8 bytes; undefined or <= 0 disables it. Does not control storage chunk size. */
	maxBlobBytes?: number
}

interface CallRecord {
	call_rowid: unknown
	payload_format: unknown
	call_id: unknown
	agent_id: unknown
	created_at: unknown
	status: unknown
	model: unknown
	request: unknown
	completed_at: unknown
	duration_ms: unknown
	provider_request_id: unknown
	response: unknown
	metrics: unknown
	error: unknown
}

const COLUMNS = 'call_id, agent_id, created_at, status, model, request, completed_at, duration_ms, provider_request_id, response, metrics, error'
const READ_COLUMNS = `rowid AS call_rowid, payload_format, ${COLUMNS}`

function toStatus(value: unknown): LLMCallStatus {
	if (value === 'running' || value === 'success' || value === 'error') return value
	throw new Error('Invalid LLM call status')
}

function optionalString(value: unknown): string | undefined {
	return value === null ? undefined : storedString(value)
}

function optionalNumber(value: unknown): number | undefined {
	return value === null ? undefined : storedNumber(value)
}

function format(value: unknown): number {
	if (value === 0 || value === PAYLOAD_FORMAT) return value
	throw new Error('Unsupported LLM call payload format')
}

export class KompjutrLLMCallLog implements LLMCallStore {
	readonly maxBlobBytes: number | undefined
	readonly #maxCallsPerSession: number
	readonly #payloads: LLMCallPayloads

	constructor(
		private readonly db: SqlDatabase,
		options: KompjutrLLMCallLogOptions = {},
	) {
		this.#maxCallsPerSession = options.maxCallsPerSession ?? DEFAULT_MAX_CALLS_PER_SESSION
		this.maxBlobBytes = options.maxBlobBytes !== undefined && options.maxBlobBytes > 0 ? options.maxBlobBytes : undefined
		this.#payloads = this.db.transactionSync(() => {
			this.db.run(`CREATE TABLE IF NOT EXISTS ${CALLS_TABLE} (
				session_id TEXT NOT NULL, call_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at INTEGER NOT NULL,
				status TEXT NOT NULL, model TEXT NOT NULL, request TEXT NOT NULL, completed_at INTEGER, duration_ms INTEGER,
				provider_request_id TEXT, response TEXT, metrics TEXT, error TEXT, payload_format INTEGER NOT NULL DEFAULT 0
			)`)
			const columns = this.db.all<{ name: unknown }>(`PRAGMA table_info(${CALLS_TABLE})`)
			if (!columns.some((column) => storedString(column.name) === 'payload_format')) {
				this.db.run(`ALTER TABLE ${CALLS_TABLE} ADD COLUMN payload_format INTEGER NOT NULL DEFAULT 0`)
			}
			this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${CALLS_TABLE}_by_id ON ${CALLS_TABLE} (session_id, call_id)`)
			return new LLMCallPayloads(db)
		})
	}

	async create(sessionId: string, row: LLMCallRow): Promise<void> {
		this.db.transactionSync(() => {
			const record = this.db.one<{ call_rowid: unknown }>(
				`INSERT INTO ${CALLS_TABLE} (session_id, ${COLUMNS}, payload_format)
				 VALUES (?, ?, '', ?, ?, '', '', ?, ?, NULL, NULL, NULL, NULL, ?) RETURNING rowid AS call_rowid`,
				sessionId,
				row.callId,
				row.createdAt,
				row.status,
				row.completedAt ?? null,
				row.durationMs ?? null,
				PAYLOAD_FORMAT,
			)
			if (record === undefined) throw new Error('Missing inserted LLM call')
			const rowid = storedNumber(record.call_rowid)
			this.#writeRequest(rowid, row)
			this.#writeOutcome(rowid, row)
			this.#trim(sessionId)
		})
	}

	async complete(sessionId: string, callId: string, outcome: LLMCallOutcome): Promise<void> {
		this.db.transactionSync(() => {
			const record = this.db.one<{ call_rowid: unknown; payload_format: unknown }>(
				`SELECT rowid AS call_rowid, payload_format FROM ${CALLS_TABLE} WHERE session_id = ? AND call_id = ?`,
				sessionId,
				callId,
			)
			if (record === undefined) return
			const rowid = storedNumber(record.call_rowid)
			if (format(record.payload_format) === 0) {
				const legacy = this.#get(sessionId, callId)
				if (legacy === null) throw new Error('Missing legacy LLM call')
				this.#writeRequest(rowid, legacy)
				this.db.run(`UPDATE ${CALLS_TABLE} SET agent_id = '', model = '', request = '' WHERE rowid = ?`, rowid)
			}
			this.#writeOutcome(rowid, outcome)
			this.db.run(
				`UPDATE ${CALLS_TABLE} SET status = ?, completed_at = ?, duration_ms = ?, payload_format = ?,
				 provider_request_id = NULL, response = NULL, metrics = NULL, error = NULL WHERE rowid = ?`,
				outcome.status,
				outcome.completedAt,
				outcome.durationMs,
				PAYLOAD_FORMAT,
				rowid,
			)
		})
	}

	async get(sessionId: string, callId: string): Promise<LLMCallRow | null> {
		return this.db.transactionSync(() => this.#get(sessionId, callId))
	}

	async list(sessionId: string, options: { limit: number; offset: number }): Promise<LLMCallPage> {
		return this.db.transactionSync(() => {
			const records = this.db.all<CallRecord>(
				`SELECT ${READ_COLUMNS} FROM ${CALLS_TABLE} WHERE session_id = ? ORDER BY call_id DESC LIMIT ? OFFSET ?`,
				sessionId,
				options.limit,
				options.offset,
			)
			return { calls: records.map((record) => this.#toRow(record)), total: this.#count(sessionId) }
		})
	}

	async delete(sessionId: string): Promise<number> {
		return this.db.transactionSync(() => {
			const calls = this.#count(sessionId)
			this.db.run(`DELETE FROM ${CALLS_TABLE} WHERE session_id = ?`, sessionId)
			return calls
		})
	}

	#get(sessionId: string, callId: string): LLMCallRow | null {
		const record = this.db.one<CallRecord>(`SELECT ${READ_COLUMNS} FROM ${CALLS_TABLE} WHERE session_id = ? AND call_id = ?`, sessionId, callId)
		return record === undefined ? null : this.#toRow(record)
	}

	#toRow(record: CallRecord): LLMCallRow {
		const rowid = storedNumber(record.call_rowid)
		const chunked = format(record.payload_format) === PAYLOAD_FORMAT
		return {
			callId: storedString(record.call_id),
			agentId: storedString(chunked ? this.#payloads.read(rowid, 'agent_id') : record.agent_id),
			createdAt: storedNumber(record.created_at),
			status: toStatus(record.status),
			model: storedString(chunked ? this.#payloads.read(rowid, 'model') : record.model),
			request: storedString(chunked ? this.#payloads.read(rowid, 'request') : record.request),
			completedAt: optionalNumber(record.completed_at),
			durationMs: optionalNumber(record.duration_ms),
			providerRequestId: chunked ? this.#payloads.read(rowid, 'provider_request_id') : optionalString(record.provider_request_id),
			response: chunked ? this.#payloads.read(rowid, 'response') : optionalString(record.response),
			metrics: chunked ? this.#payloads.read(rowid, 'metrics') : optionalString(record.metrics),
			error: chunked ? this.#payloads.read(rowid, 'error') : optionalString(record.error),
		}
	}

	#writeRequest(rowid: number, row: LLMCallRow): void {
		this.#payloads.write(rowid, 'agent_id', row.agentId)
		this.#payloads.write(rowid, 'model', row.model)
		this.#payloads.write(rowid, 'request', row.request)
	}

	#writeOutcome(rowid: number, outcome: Pick<LLMCallOutcome, 'providerRequestId' | 'response' | 'metrics' | 'error'>): void {
		this.#payloads.write(rowid, 'provider_request_id', outcome.providerRequestId)
		this.#payloads.write(rowid, 'response', outcome.response)
		this.#payloads.write(rowid, 'metrics', outcome.metrics)
		this.#payloads.write(rowid, 'error', outcome.error)
	}

	#trim(sessionId: string): void {
		if (this.#maxCallsPerSession <= 0) return
		this.db.run(
			`DELETE FROM ${CALLS_TABLE} WHERE session_id = ?
			 AND call_id < (SELECT call_id FROM ${CALLS_TABLE} WHERE session_id = ? ORDER BY call_id DESC LIMIT 1 OFFSET ?)`,
			sessionId,
			sessionId,
			this.#maxCallsPerSession - 1,
		)
	}

	#count(sessionId: string): number {
		return storedNumber(this.db.scalar(`SELECT COUNT(*) FROM ${CALLS_TABLE} WHERE session_id = ?`, sessionId))
	}
}
