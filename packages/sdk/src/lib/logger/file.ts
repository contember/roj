import type { FileSystem } from '~/platform/fs.js'
import { JsonlLogger } from './jsonl.js'
import type { LogContext, Logger } from './logger.js'

/**
 * Appends in flight per path, so lines land in the order they were logged.
 *
 * Keyed by path rather than held per instance because `child()` returns a new
 * logger over the same file, and two independent `appendFile` calls to one path
 * may complete in either order.
 */
const pendingByPath = new Map<string, Promise<void>>()

/**
 * FileLogger - writes JSONL to a file, always at debug level.
 * Each line is a JSON object with timestamp, level, message, and context.
 */
export class FileLogger extends JsonlLogger {
	constructor(private readonly filePath: string, private readonly fs: FileSystem, baseContext: LogContext = {}) {
		super(baseContext)
	}

	child(context: LogContext): Logger {
		return new FileLogger(this.filePath, this.fs, { ...this.baseContext, ...context })
	}

	protected writeLine(line: string): void {
		const path = this.filePath
		const previous = pendingByPath.get(path) ?? Promise.resolve()
		// A failed append must not break the chain — the next line still has to be written.
		const next = previous.then(() => this.fs.appendFile(path, line + '\n')).catch(() => {})
		pendingByPath.set(path, next)
		void next.then(() => {
			if (pendingByPath.get(path) === next) pendingByPath.delete(path)
		})
	}
}

/** Resolves once every line logged so far has been written. For tests and shutdown. */
export function flushFileLogs(filePath?: string): Promise<void> {
	if (filePath !== undefined) return pendingByPath.get(filePath) ?? Promise.resolve()
	return Promise.all([...pendingByPath.values()]).then(() => undefined)
}
