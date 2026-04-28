import type { LogContext, Logger, LogLevel } from './logger.js'
import { LOG_LEVEL_PRIORITY } from './logger.js'

/**
 * TeeLogger - delegates all log calls to multiple loggers.
 */
export class TeeLogger implements Logger {
	private loggers: Logger[]

	constructor(loggers: Logger[]) {
		this.loggers = loggers
	}

	get level(): LogLevel {
		let mostPermissive: LogLevel = 'error'
		for (const logger of this.loggers) {
			if (LOG_LEVEL_PRIORITY[logger.level] < LOG_LEVEL_PRIORITY[mostPermissive]) {
				mostPermissive = logger.level
			}
		}
		return mostPermissive
	}

	debug(message: string, context?: LogContext): void {
		for (const logger of this.loggers) {
			logger.debug(message, context)
		}
	}

	info(message: string, context?: LogContext): void {
		for (const logger of this.loggers) {
			logger.info(message, context)
		}
	}

	warn(message: string, context?: LogContext): void {
		for (const logger of this.loggers) {
			logger.warn(message, context)
		}
	}

	error(message: string, error?: Error, context?: LogContext): void {
		for (const logger of this.loggers) {
			logger.error(message, error, context)
		}
	}

	child(context: LogContext): Logger {
		return new TeeLogger(this.loggers.map(l => l.child(context)))
	}
}
