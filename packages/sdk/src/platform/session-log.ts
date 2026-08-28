/**
 * Session-log store adapter.
 *
 * `session.log` is the detailed record of one session. On a host with real files
 * it is a JSONL file appended to, which is the right shape there. On a host whose
 * filesystem is itself SQLite it is not, so this port lets it spend rows instead.
 *
 * Optional: a host without a table is unchanged — `SessionManager` writes the file
 * it always wrote and `logs.tail` cursors it by byte offset.
 */

export interface SessionLogPage {
	/** One serialized JSON object per entry, without the trailing newline. */
	lines: string[]
	/**
	 * Cursor to hand back as `since` on the next read.
	 *
	 * Opaque and only comparable with itself: a file-backed log counts bytes and a
	 * store-backed one counts entries, and no caller may assume which.
	 */
	offset: number
}

export interface SessionLogStore {
	/**
	 * Record one already-serialized line.
	 *
	 * Returns nothing rather than a promise, and must never throw: logging sits on
	 * the agent loop's path and nothing there awaits it. A store that cannot write
	 * drops the line, exactly as a failed file append is swallowed.
	 */
	append(sessionId: string, line: string): void

	/** Entries recorded after `since`, and the cursor that follows them. */
	read(sessionId: string, since: number): Promise<SessionLogPage>

	/** Drop every entry held for one session, and report how many went. */
	delete(sessionId: string): Promise<number>
}
