/**
 * Session-log store adapter.
 *
 * `session.log` is the detailed record of one session — every line the agent
 * loop emits, at debug level whatever `config.logLevel` says. On a host with
 * real files it is a JSONL file appended to, and that is the right shape there.
 * On a host whose filesystem is itself SQLite it is not: an append costs 12-27x
 * a row insert, and the log is 96% of the write operations a turn makes (see
 * `packages/computer-worker/README.md`, `/limits/fs-traffic`).
 *
 * So this port exists to keep the detail and pay row prices for it. Optional,
 * like {@link GitClient} and {@link FsRevision}: a host that has no table for
 * the log is unchanged — `SessionManager` writes the file it always wrote and
 * `logs.tail` cursors it by byte offset.
 */

export interface SessionLogPage {
	/** One serialized JSON object per entry, without the trailing newline. */
	lines: string[]
	/**
	 * Cursor to hand back as `since` on the next read.
	 *
	 * Opaque and only comparable with itself: a file-backed log counts bytes and
	 * a store-backed one counts entries, and no caller may assume which.
	 */
	offset: number
}

export interface SessionLogStore {
	/**
	 * Record one already-serialized line.
	 *
	 * Returns nothing rather than a promise, and must never throw: logging sits on
	 * the agent loop's path and nothing there awaits it. A store that cannot write
	 * drops the line, exactly as `FileLogger` swallows a failed append.
	 */
	append(sessionId: string, line: string): void

	/** Entries recorded after `since`, and the cursor that follows them. */
	read(sessionId: string, since: number): Promise<SessionLogPage>

	/**
	 * Drop every entry held for one session, and report how many went.
	 *
	 * The log lives under the session's data directory on a file host, so it is
	 * reclaimed with the *files*, not with the event log — see `createSessionReaper`.
	 */
	delete(sessionId: string): Promise<number>
}
