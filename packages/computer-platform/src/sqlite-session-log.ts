/**
 * `session.log` as rows in a Durable Object's SQLite rather than a file in the workspace.
 *
 * The workspace filesystem is itself SQLite, so appending a log line is a `lstat`
 * plus a ranged write through the VFS — 0.6-1.2 ms, against 0.053 ms for one
 * bound INSERT. The log is 96% of the write operations a turn makes and 98% of
 * its bytes, so the file shape is what a turn spends its I/O on. See
 * `packages/computer-worker/README.md`, `/limits/fs-traffic`.
 *
 * Clustered on `(session_id, seq)` `WITHOUT ROWID`, like `SqliteEventStore`: one
 * session's lines are contiguous and a tail is a seek down the key.
 */

import type { SessionLogPage, SessionLogStore } from '@roj-ai/sdk/platform'
import type { SqlStorageHost } from './sqlite-event-store.js'

const LOG_TABLE = 'roj_session_log'

interface LogRow {
	seq: number
	line: string
}

export class SqliteSessionLog implements SessionLogStore {
	/** Next seq per session, so an append does not re-derive MAX(seq) every line. */
	private readonly nextSeq = new Map<string, number>()

	constructor(private readonly storage: SqlStorageHost) {
		this.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
				session_id TEXT NOT NULL,
				seq INTEGER NOT NULL,
				line TEXT NOT NULL,
				PRIMARY KEY (session_id, seq)
			) WITHOUT ROWID`,
		)
	}

	append(sessionId: string, line: string): void {
		try {
			this.storage.sql.exec(
				`INSERT INTO ${LOG_TABLE} (session_id, seq, line) VALUES (?, ?, ?)`,
				sessionId,
				this.claimSeq(sessionId),
				line,
			)
		} catch {
			// A dropped log line must never fail the caller — FileLogger swallows a
			// failed append for the same reason, and nothing awaits either.
		}
	}

	async read(sessionId: string, since: number): Promise<SessionLogPage> {
		const rows = this.storage.sql
			.exec<LogRow>(`SELECT seq, line FROM ${LOG_TABLE} WHERE session_id = ? AND seq > ? ORDER BY seq`, sessionId, since)
			.toArray()

		const last = rows[rows.length - 1]
		if (last !== undefined) {
			return { lines: rows.map((row) => row.line), offset: last.seq }
		}

		// Nothing after `since`: report the tail, so a cursor left past the end —
		// a reaped session, a fresh table — rewinds instead of sticking. This is what
		// the file path does by returning the file size.
		return { lines: [], offset: Math.min(since, this.maxSeq(sessionId)) }
	}

	async delete(sessionId: string): Promise<number> {
		const lines = this.countRows(sessionId)
		// SQLite frees the pages but does not shrink the file, so databaseSize holds.
		this.storage.sql.exec(`DELETE FROM ${LOG_TABLE} WHERE session_id = ?`, sessionId)
		// Per-session state; a deleted session must not keep a seq to continue from.
		this.nextSeq.delete(sessionId)
		return lines
	}

	/** 1-based, so the default `since: 0` includes the very first line. */
	private claimSeq(sessionId: string): number {
		const seq = this.nextSeq.get(sessionId) ?? this.maxSeq(sessionId) + 1
		this.nextSeq.set(sessionId, seq + 1)
		return seq
	}

	/** Last stored seq, 0 when the session has none. */
	private maxSeq(sessionId: string): number {
		const rows = this.storage.sql
			.exec<{ max_seq: number | null }>(`SELECT MAX(seq) AS max_seq FROM ${LOG_TABLE} WHERE session_id = ?`, sessionId)
			.toArray()

		return rows[0]?.max_seq ?? 0
	}

	private countRows(sessionId: string): number {
		const rows = this.storage.sql
			.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${LOG_TABLE} WHERE session_id = ?`, sessionId)
			.toArray()

		return rows[0]?.count ?? 0
	}
}
