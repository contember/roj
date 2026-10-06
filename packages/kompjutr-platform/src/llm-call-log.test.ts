import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '@kompjutr/do'
import type { LLMCallOutcome, LLMCallRow } from '@roj-ai/sdk/platform'
import { KompjutrLLMCallLog } from './llm-call-log.js'
import { BunSqliteStorage } from './testing/storage.js'

const storages: BunSqliteStorage[] = []
const encoder = new TextEncoder()
const outcome: LLMCallOutcome = { status: 'success', completedAt: 20, durationMs: 10 }

afterEach(() => {
	for (const storage of storages.splice(0)) storage.close()
})

function row(callId = 'call-001', overrides: Partial<LLMCallRow> = {}): LLMCallRow {
	return { callId, agentId: 'agent', createdAt: 10, status: 'running', model: 'model', request: '{ "messages": [] }', ...overrides }
}

function bytes(value: unknown): number {
	if (value === null) return 0
	if (typeof value === 'number') return 8
	if (typeof value === 'string') return encoder.encode(value).byteLength
	if (value instanceof ArrayBuffer || value instanceof Uint8Array) return value.byteLength
	throw new Error('Unexpected SQL value')
}

function fixture(options: ConstructorParameters<typeof KompjutrLLMCallLog>[1] = {}) {
	const storage = new BunSqliteStorage()
	storages.push(storage)
	const queries: string[] = []
	const guard = { maxResultRowBytes: 0, maxBindingBytes: 0, fail: (_query: string) => false }
	const execute = storage.sql.exec.bind(storage.sql)
	storage.sql.exec = (query, ...bindings) => {
		queries.push(query)
		if (guard.fail(query)) throw new Error('injected database failure')
		const bindingBytes = bindings.reduce<number>((total, value) => total + bytes(value), 0)
		guard.maxBindingBytes = Math.max(guard.maxBindingBytes, bindingBytes)
		if (bindingBytes + 128 > 2_000_000) throw new Error('SQL binding row exceeds conservative 2 MB budget')
		const cursor = execute(query, ...bindings)
		function* measuredRows() {
			for (const result of cursor) {
				const size = Object.values(result).reduce<number>((total, value) => total + bytes(value), 0)
				guard.maxResultRowBytes = Math.max(guard.maxResultRowBytes, size)
				if (size + 128 > 2_000_000) throw new Error('SQL result row exceeds conservative 2 MB budget')
				yield result
			}
		}
		return { [Symbol.iterator]: measuredRows, toArray: () => Array.from(measuredRows()) }
	}
	const db = new Database(storage)
	const log = new KompjutrLLMCallLog(db, options)
	return { storage, db, log, guard, queries }
}

function assertBoundedRows(db: Database): void {
	for (const table of ['roj_llm_call', 'roj_llm_payload', 'roj_llm_payload_chunk']) {
		for (const record of db.all(`SELECT * FROM ${table}`)) {
			const size = Object.values(record).reduce<number>((total, value) => total + bytes(value), 0)
			expect(size + 128).toBeLessThan(2_000_000)
		}
	}
	expect(db.scalar<number>('SELECT MAX(length(data)) FROM roj_llm_payload_chunk')).toBeLessThanOrEqual(256 * 1024)
}

function assertNoOrphans(db: Database): void {
	for (const table of ['roj_llm_payload', 'roj_llm_payload_chunk']) {
		expect(db.scalar<number>(`SELECT COUNT(*) FROM ${table} WHERE call_rowid NOT IN (SELECT rowid FROM roj_llm_call)`)).toBe(0)
	}
}

test('round-trips combined payloads over 2 MB and a single request over 8 MiB through get and list', async () => {
	const { log, db, guard } = fixture()
	const original = row('call-001', {
		request: ` {"large": "${'x'.repeat(9 * 1024 * 1024)}"} `,
		agentId: 'a'.repeat(2_100_000),
		model: 'm'.repeat(2_100_000),
	})
	const completed: LLMCallOutcome = {
		...outcome,
		providerRequestId: 'p'.repeat(2_100_000),
		response: 'r'.repeat(1_100_000),
		metrics: 'm'.repeat(1_100_000),
		error: 'e'.repeat(1_100_000),
	}
	await log.create('session', original)
	await log.complete('session', original.callId, completed)
	expect(await log.get('session', original.callId)).toEqual({ ...original, ...completed })
	expect(await log.list('session', { limit: 10, offset: 0 })).toEqual({ calls: [{ ...original, ...completed }], total: 1 })
	assertBoundedRows(db)
	expect(guard.maxResultRowBytes).toBeLessThan(257 * 1024)
	expect(guard.maxBindingBytes).toBeLessThan(257 * 1024)
})

test('preserves multibyte text across byte boundaries, NUL, escapes and lone surrogates', async () => {
	const { log } = fixture()
	const text = `${'x'.repeat(256 * 1024 - 2)}😀č漢${'🦊ě'.repeat(100_000)}\u0000\n\\"\ud800end\udfff`
	const original = row('unicode', { request: text, response: text, providerRequestId: text })
	await log.create('session', original)
	expect(await log.get('session', original.callId)).toEqual(original)
	expect((await log.list('session', { limit: 1, offset: 0 })).calls).toEqual([original])
})

test('completed creates and repeated completes distinguish missing fields from empty strings', async () => {
	const { log } = fixture()
	const original = row('complete', { ...outcome, providerRequestId: '', response: '', metrics: '', error: '' })
	await log.create('session', original)
	expect(await log.get('session', original.callId)).toEqual(original)
	await log.complete('session', original.callId, { ...outcome, status: 'error', error: 'failed', response: 'large'.repeat(100_000) })
	await log.complete('session', original.callId, outcome)
	expect(await log.get('session', original.callId)).toEqual({
		...original,
		providerRequestId: undefined,
		response: undefined,
		metrics: undefined,
		error: undefined,
	})
})

test('normal completion never reads or rewrites request payloads', async () => {
	const { log, db, queries, guard } = fixture()
	await log.create('session', row())
	const before = db.all("SELECT * FROM roj_llm_payload_chunk WHERE field IN ('agent_id', 'model', 'request')")
	queries.length = 0
	guard.fail = (query) => query.startsWith('SELECT') && (query.includes('data') || query.includes('request'))
	await log.complete('session', 'call-001', { ...outcome, response: 'response' })
	expect(queries.some((query) => query.includes("SET agent_id = ''"))).toBe(false)
	guard.fail = () => false
	expect(db.all("SELECT * FROM roj_llm_payload_chunk WHERE field IN ('agent_id', 'model', 'request')")).toEqual(before)
})

test('retention, paging, duplicate IDs and deletion preserve session isolation with no orphan blocks', async () => {
	const { log, db } = fixture({ maxCallsPerSession: 2 })
	await log.create('other', row())
	await log.create('session', row('call-001'))
	await log.create('session', row('call-003'))
	await log.create('session', row('call-002'))
	await expect(log.create('session', row('call-002'))).rejects.toThrow()
	expect(await log.list('session', { limit: 1, offset: 0 })).toEqual({ calls: [row('call-003')], total: 2 })
	expect(await log.list('session', { limit: 1, offset: 1 })).toEqual({ calls: [row('call-002')], total: 2 })
	expect(await log.list('session', { limit: 1, offset: 2 })).toEqual({ calls: [], total: 2 })
	expect(await log.get('session', 'call-001')).toBeNull()
	const count = db.scalar<number>('SELECT COUNT(*) FROM roj_llm_payload_chunk')
	await log.complete('session', 'call-001', { ...outcome, response: 'reaped' })
	expect(db.scalar<number>('SELECT COUNT(*) FROM roj_llm_payload_chunk')).toBe(count)
	assertNoOrphans(db)
	expect(await log.delete('session')).toBe(2)
	expect(await log.delete('session')).toBe(0)
	expect(await log.get('other', 'call-001')).toEqual(row())
	await log.complete('session', 'call-002', outcome)
	assertNoOrphans(db)
	expect(await log.delete('other')).toBe(1)
	expect(db.scalar<number>('SELECT COUNT(*) FROM roj_llm_payload')).toBe(0)
	expect(db.scalar<number>('SELECT COUNT(*) FROM roj_llm_payload_chunk')).toBe(0)
})

test('create and completion failures after chunk writes roll back all state', async () => {
	const { log, db, guard, queries } = fixture()
	await log.create('session', row())
	guard.fail = (query) => query.startsWith('DELETE FROM roj_llm_call')
	queries.length = 0
	await expect(log.create('session', row('call-002', { request: 'x'.repeat(600_000) }))).rejects.toThrow('injected database failure')
	expect(queries.filter((query) => query.startsWith('INSERT INTO roj_llm_payload_chunk')).length).toBeGreaterThan(2)
	guard.fail = (query) => query.startsWith('UPDATE roj_llm_call')
	queries.length = 0
	await expect(log.complete('session', 'call-001', { ...outcome, response: 'r'.repeat(600_000) })).rejects.toThrow('injected database failure')
	expect(queries.filter((query) => query.startsWith('INSERT INTO roj_llm_payload_chunk')).length).toBe(3)
	guard.fail = () => false
	expect(await log.get('session', 'call-001')).toEqual(row())
	expect(await log.get('session', 'call-002')).toBeNull()
	expect(db.scalar<number>("SELECT COUNT(*) FROM roj_llm_payload_chunk WHERE field = 'response'")).toBe(0)
	assertNoOrphans(db)
})

test('retention and delete trigger failures roll back parent rows and their blocks', async () => {
	const { log, db } = fixture({ maxCallsPerSession: 1 })
	await log.create('session', row())
	db.run(`CREATE TRIGGER fail_payload_delete BEFORE DELETE ON roj_llm_payload BEGIN SELECT RAISE(ABORT, 'delete failed'); END`)
	await expect(log.create('session', row('call-002'))).rejects.toThrow('delete failed')
	await expect(log.delete('session')).rejects.toThrow('delete failed')
	expect(await log.get('session', 'call-001')).toEqual(row())
	expect(await log.get('session', 'call-002')).toBeNull()
	assertNoOrphans(db)
	db.run('DROP TRIGGER fail_payload_delete')
	expect(await log.delete('session')).toBe(1)
	assertNoOrphans(db)
})

function createLegacy(db: Database, original: LLMCallRow): void {
	db.run(`CREATE TABLE roj_llm_call (
		session_id TEXT NOT NULL, call_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at INTEGER NOT NULL,
		status TEXT NOT NULL, model TEXT NOT NULL, request TEXT NOT NULL, completed_at INTEGER, duration_ms INTEGER,
		provider_request_id TEXT, response TEXT, metrics TEXT, error TEXT
	)`)
	db.run(
		'INSERT INTO roj_llm_call VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
		'session',
		original.callId,
		original.agentId,
		original.createdAt,
		original.status,
		original.model,
		original.request,
		original.completedAt ?? null,
		original.durationMs ?? null,
		original.providerRequestId ?? null,
		original.response ?? null,
		original.metrics ?? null,
		original.error ?? null,
	)
}

test('reads old schema near-limit rows, migrates on completion, and survives reopening', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'llm-call-log-'))
	const path = join(directory, 'calls.sqlite')
	let storage = new BunSqliteStorage(path)
	try {
		const original = row('legacy', { request: ' '.repeat(1_990_000), response: '', providerRequestId: 'legacy-id' })
		createLegacy(new Database(storage), original)
		let log = new KompjutrLLMCallLog(new Database(storage))
		expect(await log.get('session', 'legacy')).toEqual(original)
		expect(await log.list('session', { limit: 10, offset: 0 })).toEqual({ calls: [original], total: 1 })
		const completed = { ...outcome, response: 'response'.repeat(400_000) }
		await log.complete('session', 'legacy', completed)
		const expected = { ...original, ...completed, providerRequestId: undefined }
		expect(await log.get('session', 'legacy')).toEqual(expected)
		assertBoundedRows(new Database(storage))
		storage.close()
		storage = new BunSqliteStorage(path)
		log = new KompjutrLLMCallLog(new Database(storage))
		expect(await log.get('session', 'legacy')).toEqual(expected)
		await log.complete('session', 'legacy', { ...outcome, error: '' })
		expect(await log.get('session', 'legacy')).toEqual({ ...expected, response: undefined, error: '' })
	} finally {
		storage.close()
		rmSync(directory, { recursive: true, force: true })
	}
})

test('a failed legacy migration retains the old inline payload and format marker', async () => {
	const storage = new BunSqliteStorage()
	storages.push(storage)
	const db = new Database(storage)
	const original = row('legacy', { request: 'r'.repeat(800_000), response: 'old response' })
	createLegacy(db, original)
	const log = new KompjutrLLMCallLog(db)
	db.run(`CREATE TRIGGER fail_completion BEFORE UPDATE OF status ON roj_llm_call BEGIN SELECT RAISE(ABORT, 'completion failed'); END`)
	await expect(log.complete('session', 'legacy', { ...outcome, response: 'new response' })).rejects.toThrow('completion failed')
	expect(await log.get('session', 'legacy')).toEqual(original)
	expect(db.scalar<number>('SELECT payload_format FROM roj_llm_call')).toBe(0)
	expect(db.scalar<number>('SELECT COUNT(*) FROM roj_llm_payload')).toBe(0)
	expect(db.scalar<number>('SELECT COUNT(*) FROM roj_llm_payload_chunk')).toBe(0)
})

test('empty inline and chunked strings are distinguished by the format marker', async () => {
	const storage = new BunSqliteStorage()
	storages.push(storage)
	const db = new Database(storage)
	const original = row('legacy-empty', { agentId: '', model: '', request: '', response: '', metrics: '', error: '', providerRequestId: '' })
	createLegacy(db, original)
	const log = new KompjutrLLMCallLog(db)
	expect(await log.get('session', original.callId)).toEqual(original)
	await log.create('session', { ...original, callId: 'new-empty' })
	expect(await log.get('session', 'new-empty')).toEqual({ ...original, callId: 'new-empty' })
	await log.complete('session', original.callId, { ...outcome, response: '', metrics: '', error: '', providerRequestId: '' })
	expect(await log.get('session', original.callId)).toEqual({ ...original, ...outcome })
})

test.each([
	"DELETE FROM roj_llm_payload_chunk WHERE field = 'request' AND chunk_index = 0",
	"UPDATE roj_llm_payload_chunk SET chunk_index = 100 WHERE field = 'request' AND chunk_index = 0",
	"UPDATE roj_llm_payload_chunk SET data = x'ff' WHERE field = 'request' AND chunk_index = 0",
	"UPDATE roj_llm_payload_chunk SET data = zeroblob(length(data)) WHERE field = 'request' AND chunk_index = 0",
	"UPDATE roj_llm_payload SET byte_length = byte_length + 1 WHERE field = 'request'",
	"UPDATE roj_llm_payload SET chunk_count = 'corrupt' WHERE field = 'request'",
	"DELETE FROM roj_llm_payload WHERE field = 'response'",
	'UPDATE roj_llm_call SET payload_format = 999',
])('corrupt storage fails visibly on get and list: %s', async (corruption) => {
	const { log, db } = fixture()
	await log.create('session', row('corrupt', { request: 'x'.repeat(300_000) }))
	db.run(corruption)
	await expect(log.get('session', 'corrupt')).rejects.toThrow()
	await expect(log.list('session', { limit: 1, offset: 0 })).rejects.toThrow()
})

test('maxBlobBytes is an opt-in caller clamp and never a storage chunk size or adapter truncation', async () => {
	expect(fixture().log.maxBlobBytes).toBeUndefined()
	expect(fixture({ maxBlobBytes: 0 }).log.maxBlobBytes).toBeUndefined()
	const { log } = fixture({ maxBlobBytes: 64 })
	expect(log.maxBlobBytes).toBe(64)
	const original = row('unclamped-direct-write', { request: 'x'.repeat(600_000) })
	await log.create('session', original)
	expect(await log.get('session', original.callId)).toEqual(original)
})
