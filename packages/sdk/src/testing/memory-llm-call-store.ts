import type { LLMCallOutcome, LLMCallPage, LLMCallRow, LLMCallStore } from '~/platform/llm-call-log.js'

/**
 * In-memory {@link LLMCallStore}, and the reference for what one must do.
 *
 * A real store is a table; this is the same contract without one, so a test can
 * drive `LLMLogger`'s store path without a database. Ordering, page boundaries
 * and the missing-call no-op are spelled out here because they are the parts a
 * host has to get right — see `SqliteLLMCallLog` for the SQL of the same thing.
 */
export class MemoryLLMCallStore implements LLMCallStore {
	private readonly calls = new Map<string, Map<string, LLMCallRow>>()

	/** Set to give the store a column ceiling, as a Durable Object has. */
	constructor(readonly maxBlobBytes?: number) {}

	async create(sessionId: string, row: LLMCallRow): Promise<void> {
		let session = this.calls.get(sessionId)
		if (session === undefined) {
			session = new Map()
			this.calls.set(sessionId, session)
		}
		session.set(row.callId, { ...row })
	}

	async complete(sessionId: string, callId: string, outcome: LLMCallOutcome): Promise<void> {
		const row = this.calls.get(sessionId)?.get(callId)
		// A call the store no longer holds is not an error — a reap between the two
		// halves of one inference is exactly that case.
		if (row === undefined) return
		Object.assign(row, outcome)
	}

	async get(sessionId: string, callId: string): Promise<LLMCallRow | null> {
		const row = this.calls.get(sessionId)?.get(callId)
		return row === undefined ? null : { ...row }
	}

	async list(sessionId: string, options: { limit: number; offset: number }): Promise<LLMCallPage> {
		// UUIDv7 descending, which is newest first and a total order.
		const rows = [...(this.calls.get(sessionId)?.values() ?? [])]
			.sort((a, b) => (a.callId < b.callId ? 1 : a.callId > b.callId ? -1 : 0))

		return {
			calls: rows.slice(options.offset, options.offset + options.limit).map((row) => ({ ...row })),
			total: rows.length,
		}
	}

	async delete(sessionId: string): Promise<number> {
		const removed = this.calls.get(sessionId)?.size ?? 0
		this.calls.delete(sessionId)
		return removed
	}
}
