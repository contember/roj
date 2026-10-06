import type { SqlDatabase } from '@kompjutr/do'

const CHUNK_BYTES = 256 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

type PayloadField = 'agent_id' | 'model' | 'request' | 'provider_request_id' | 'response' | 'metrics' | 'error'

export function storedString(value: unknown): string {
	if (typeof value !== 'string') throw new Error('Invalid LLM call string')
	return value
}

export function storedNumber(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid LLM call number')
	return value
}

function storedInteger(value: unknown): number {
	const number = storedNumber(value)
	if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid LLM payload integer')
	return number
}

export class LLMCallPayloads {
	constructor(private readonly db: SqlDatabase) {
		db.run(`CREATE TABLE IF NOT EXISTS roj_llm_payload (
			call_rowid INTEGER NOT NULL, field TEXT NOT NULL, chunk_count INTEGER NOT NULL, byte_length INTEGER,
			PRIMARY KEY (call_rowid, field)
		) WITHOUT ROWID`)
		db.run(`CREATE TABLE IF NOT EXISTS roj_llm_payload_chunk (
			call_rowid INTEGER NOT NULL, field TEXT NOT NULL, chunk_index INTEGER NOT NULL, data BLOB NOT NULL,
			PRIMARY KEY (call_rowid, field, chunk_index)
		) WITHOUT ROWID`)
		// Explicit cleanup also works when the host leaves SQLite foreign keys disabled.
		db.run(`CREATE TRIGGER IF NOT EXISTS roj_llm_call_payload_delete AFTER DELETE ON roj_llm_call BEGIN
			DELETE FROM roj_llm_payload_chunk WHERE call_rowid = OLD.rowid;
			DELETE FROM roj_llm_payload WHERE call_rowid = OLD.rowid;
		END`)
	}

	write(rowid: number, field: PayloadField, value: string | undefined): void {
		// JSON string encoding preserves even lone UTF-16 surrogates through UTF-8 storage.
		const bytes = value === undefined ? undefined : encoder.encode(JSON.stringify(value))
		const count = bytes === undefined ? 0 : Math.ceil(bytes.byteLength / CHUNK_BYTES)
		this.db.run('DELETE FROM roj_llm_payload_chunk WHERE call_rowid = ? AND field = ?', rowid, field)
		this.db.run(
			'INSERT OR REPLACE INTO roj_llm_payload (call_rowid, field, chunk_count, byte_length) VALUES (?, ?, ?, ?)',
			rowid,
			field,
			count,
			bytes?.byteLength ?? null,
		)
		if (bytes === undefined) return
		for (let index = 0; index < count; index++) {
			this.db.run(
				'INSERT INTO roj_llm_payload_chunk (call_rowid, field, chunk_index, data) VALUES (?, ?, ?, ?)',
				rowid,
				field,
				index,
				bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).buffer,
			)
		}
	}

	read(rowid: number, field: PayloadField): string | undefined {
		const metadata = this.db.one<{ chunk_count: unknown; byte_length: unknown }>(
			'SELECT chunk_count, byte_length FROM roj_llm_payload WHERE call_rowid = ? AND field = ?',
			rowid,
			field,
		)
		if (metadata === undefined) throw new Error(`Missing LLM payload metadata: ${field}`)
		const count = storedInteger(metadata.chunk_count)
		const length = metadata.byte_length === null ? null : storedInteger(metadata.byte_length)
		if (count !== (length === null ? 0 : Math.ceil(length / CHUNK_BYTES)) || length === 0) throw new Error(`Invalid LLM payload size: ${field}`)
		const chunks = this.db.all<{ chunk_index: unknown; data: unknown }>(
			'SELECT chunk_index, data FROM roj_llm_payload_chunk WHERE call_rowid = ? AND field = ? ORDER BY chunk_index',
			rowid,
			field,
		)
		if (chunks.length !== count) throw new Error(`Missing or extra LLM payload chunks: ${field}`)
		if (length === null) return undefined
		const bytes = new Uint8Array(length)
		for (const [index, chunk] of chunks.entries()) {
			if (storedInteger(chunk.chunk_index) !== index) throw new Error(`Invalid LLM payload order: ${field}`)
			const data = chunk.data instanceof ArrayBuffer ? new Uint8Array(chunk.data) : chunk.data
			if (!(data instanceof Uint8Array) || data.byteLength !== Math.min(CHUNK_BYTES, length - index * CHUNK_BYTES)) {
				throw new Error(`Invalid LLM payload chunk: ${field}`)
			}
			bytes.set(data, index * CHUNK_BYTES)
		}
		const value: unknown = JSON.parse(decoder.decode(bytes))
		return storedString(value)
	}
}
