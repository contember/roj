/**
 * `session.log` as rows rather than a file in the workspace.
 *
 * The workspace filesystem is itself SQLite, so appending a log line means
 * reading the file's length and writing a range through it, where a bound
 * INSERT is one statement. The session log is the great majority of the write
 * operations a turn makes, so the file shape is what a turn spends its I/O on.
 *
 * Clustered on `(session_id, seq)` `WITHOUT ROWID`: one session's lines are
 * contiguous and a tail read is a seek down the key rather than a scan.
 */

import type { SessionLogPage, SessionLogStore } from '@roj-ai/sdk/platform'
import type { SqlDatabase } from 'kompjutr'

const LOG_TABLE = 'roj_session_log'

export class KompjutrSessionLog implements SessionLogStore {
	/** Next seq per session, so an append does not re-derive MAX(seq) per line. */
	readonly #nextSeq = new Map<string, number>()

	constructor(private readonly db: SqlDatabase) {
		this.db.run(
			`CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
				session_id TEXT NOT NULL,
				seq INTEGER NOT NULL,
				line TEXT NOT NULL,
				PRIMARY KEY (session_id, seq)
			) WITHOUT ROWID`,
		)
	}

	append(sessionId: string, line: string): void {
		const seq = this.#claimSeq(sessionId)
		try {
			this.db.run(`INSERT INTO ${LOG_TABLE} (session_id, seq, line) VALUES (?, ?, ?)`, sessionId, seq, line)
		} catch {
			// A dropped line must never fail the caller — nothing awaits logging, and
			// the file logger swallows a failed append for the same reason. The cached
			// seq goes with it: if this collided, keeping it would collide forever.
			this.#nextSeq.delete(sessionId)
		}
	}

	async read(sessionId: string, since: number): Promise<SessionLogPage> {
		const rows = this.db.all<{ seq: number; line: string }>(
			`SELECT seq, line FROM ${LOG_TABLE} WHERE session_id = ? AND seq > ? ORDER BY seq`,
			sessionId,
			since,
		)

		const last = rows[rows.length - 1]
		if (last !== undefined) return { lines: rows.map((row) => row.line), offset: last.seq }

		// Nothing after `since`: report the tail, so a cursor left past the end — a
		// reaped session, a fresh table — rewinds instead of sticking there.
		return { lines: [], offset: Math.min(since, this.#maxSeq(sessionId)) }
	}

	async delete(sessionId: string): Promise<number> {
		const lines = this.db.scalar<number>(`SELECT COUNT(*) FROM ${LOG_TABLE} WHERE session_id = ?`, sessionId) ?? 0
		this.db.run(`DELETE FROM ${LOG_TABLE} WHERE session_id = ?`, sessionId)
		// Per-session state; a deleted session must not keep a seq to continue from.
		this.#nextSeq.delete(sessionId)
		return lines
	}

	/** 1-based, so the default `since: 0` includes the very first line. */
	#claimSeq(sessionId: string): number {
		const seq = this.#nextSeq.get(sessionId) ?? this.#maxSeq(sessionId) + 1
		this.#nextSeq.set(sessionId, seq + 1)
		return seq
	}

	/** Last stored seq, 0 when the session has none. */
	#maxSeq(sessionId: string): number {
		return this.db.scalar<number | null>(`SELECT MAX(seq) FROM ${LOG_TABLE} WHERE session_id = ?`, sessionId) ?? 0
	}
}
