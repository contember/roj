import type { FileSystem } from '~/platform/fs.js'
import { JsonlLogger } from './jsonl.js'
import type { LogContext, Logger } from './logger.js'

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
		this.fs.appendFile(this.filePath, line + '\n').catch(() => {
			// Silently ignore write errors to avoid disrupting the application
		})
	}
}
