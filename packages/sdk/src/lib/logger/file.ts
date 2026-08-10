import type { FileSystem } from '~/platform/fs.js'
import { JsonlLogger } from './jsonl.js'
import type { LogContext, Logger } from './logger.js'

/**
 * Lines logged while an append to that file is in flight.
 *
 * Keyed by path rather than by instance because the instance is not the writer:
 * `child()` makes a new FileLogger over the same file, and concurrent appends
 * land in whatever order the filesystem finishes them.
 */
const pendingByPath = new Map<string, string[]>()

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
		const pending = pendingByPath.get(this.filePath)
		if (pending) {
			// A drain already owns this file; it writes what it finds, in order.
			pending.push(line + '\n')
			return
		}

		const own = [line + '\n']
		pendingByPath.set(this.filePath, own)
		void this.drain(own)
	}

	/** Writes what is queued, then whatever was logged while that write was in flight. */
	private async drain(pending: string[]): Promise<void> {
		while (pending.length > 0) {
			const chunk = pending.join('')
			pending.length = 0

			try {
				await this.fs.appendFile(this.filePath, chunk)
			} catch {
				// Silently ignore write errors to avoid disrupting the application
			}
		}

		// Nothing arrived since the last check, and nothing can until we yield.
		pendingByPath.delete(this.filePath)
	}
}
