import type { FileSystem } from '~/platform/fs.js'
import type { LogContext, Logger, LogLevel } from './logger.js'
import { BaseLogger } from './logger.js'

/**
 * FileLogger - writes JSONL to a file, always at debug level.
 * Each line is a JSON object with timestamp, level, message, and context.
 */
export class FileLogger extends BaseLogger {
	readonly level: LogLevel = 'debug'
	private filePath: string
	private baseContext: LogContext
	private fs: FileSystem

	constructor(filePath: string, fs: FileSystem, baseContext: LogContext = {}) {
		super()
		this.filePath = filePath
		this.fs = fs
		this.baseContext = baseContext
	}


	child(context: LogContext): Logger {
		return new FileLogger(this.filePath, this.fs, { ...this.baseContext, ...context })
	}

	protected log(level: LogLevel, message: string, context?: LogContext): void {
		const entry = {
			timestamp: new Date().toISOString(),
			level,
			message,
			...this.baseContext,
			...context,
		}

		const line = JSON.stringify(entry) + '\n'
		this.fs.appendFile(this.filePath, line).catch(() => {
			// Silently ignore write errors to avoid disrupting the application
		})
	}
}
