import type { FileSystem } from '~/platform/fs.js'
import type { LogContext, Logger, LogLevel } from './logger.js'

/**
 * FileLogger - writes JSONL to a file, always at debug level.
 * Each line is a JSON object with timestamp, level, message, and context.
 */
export class FileLogger implements Logger {
	readonly level: LogLevel = 'debug'
	private filePath: string
	private baseContext: LogContext
	private fs: FileSystem

	constructor(filePath: string, fs: FileSystem, baseContext: LogContext = {}) {
		this.filePath = filePath
		this.fs = fs
		this.baseContext = baseContext
	}

	debug(message: string, context?: LogContext): void {
		this.log('debug', message, context)
	}

	info(message: string, context?: LogContext): void {
		this.log('info', message, context)
	}

	warn(message: string, context?: LogContext): void {
		this.log('warn', message, context)
	}

	error(message: string, error?: Error, context?: LogContext): void {
		const errorContext = error
			? {
				...context,
				error: {
					name: error.name,
					message: error.message,
					stack: error.stack,
				},
			}
			: context

		this.log('error', message, errorContext)
	}

	child(context: LogContext): Logger {
		return new FileLogger(this.filePath, this.fs, { ...this.baseContext, ...context })
	}

	private log(level: LogLevel, message: string, context?: LogContext): void {
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
