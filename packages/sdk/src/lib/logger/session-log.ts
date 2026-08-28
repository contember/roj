import type { Platform } from '~/platform/index.js'
import type { SessionLogStore } from '~/platform/session-log.js'
import { FileLogger } from './file.js'
import { JsonlLogger } from './jsonl.js'
import type { LogContext, Logger } from './logger.js'

/** The same JSONL FileLogger writes, into a {@link SessionLogStore} row. */
export class SessionLogStoreLogger extends JsonlLogger {
	constructor(private readonly store: SessionLogStore, private readonly sessionId: string, baseContext: LogContext = {}) {
		super(baseContext)
	}

	child(context: LogContext): Logger {
		return new SessionLogStoreLogger(this.store, this.sessionId, { ...this.baseContext, ...context })
	}

	protected writeLine(line: string): void {
		try {
			this.store.append(this.sessionId, line)
		} catch {
			// Dropped exactly as a failed file append is — nothing on the agent loop awaits this.
		}
	}
}

/**
 * The session's own log sink: rows where the host has a table for them, the
 * `session.log` file everywhere else.
 *
 * The absence of `platform.sessionLog` is the status quo — same file, same
 * bytes, same byte-offset cursor in `logs.tail`.
 */
export function createSessionLogger(
	platform: Pick<Platform, 'fs' | 'sessionLog'>,
	sessionId: string,
	logPath: string,
): Logger {
	const store = platform.sessionLog
	return store === undefined
		? new FileLogger(logPath, platform.fs, { sessionId })
		: new SessionLogStoreLogger(store, sessionId, { sessionId })
}
