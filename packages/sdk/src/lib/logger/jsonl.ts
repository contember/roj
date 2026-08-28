import type { LogContext, Logger, LogLevel } from './logger.js'
import { BaseLogger } from './logger.js'

/**
 * One JSON object per entry, always at debug level.
 *
 * The level is deliberately not `config.logLevel`: the session log is the
 * detailed record and the console logger is the filtered one.
 *
 * Shared by the file sink and the store sink so a host that moves the log into
 * a table emits exactly the same entries — the sink is the only difference.
 */
export abstract class JsonlLogger extends BaseLogger {
	readonly level: LogLevel = 'debug'

	constructor(protected readonly baseContext: LogContext = {}) {
		super()
	}

	abstract child(context: LogContext): Logger

	/** Takes one finished entry, no trailing newline. Must never throw. */
	protected abstract writeLine(line: string): void

	protected log(level: LogLevel, message: string, context?: LogContext): void {
		const entry = {
			timestamp: new Date().toISOString(),
			level,
			message,
			...this.baseContext,
			...context,
		}

		this.writeLine(JSON.stringify(entry))
	}
}
