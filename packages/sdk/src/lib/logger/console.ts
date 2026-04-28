import type { LogContext, Logger, LogLevel } from './logger.js'
import { shouldLog } from './logger.js'

export interface ConsoleLoggerConfig {
	level: LogLevel
	colors?: boolean
	timestamps?: boolean
}

const COLORS = {
	reset: '\x1b[0m',
	debug: '\x1b[36m', // cyan
	info: '\x1b[32m', // green
	warn: '\x1b[33m', // yellow
	error: '\x1b[31m', // red
}

export class ConsoleLogger implements Logger {
	readonly level: LogLevel
	private useColors: boolean
	private showTimestamps: boolean
	private baseContext: LogContext

	constructor(config: ConsoleLoggerConfig, baseContext: LogContext = {}) {
		this.level = config.level
		this.useColors = config.colors ?? true
		this.showTimestamps = config.timestamps ?? true
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
		return new ConsoleLogger(
			{
				level: this.level,
				colors: this.useColors,
				timestamps: this.showTimestamps,
			},
			{ ...this.baseContext, ...context },
		)
	}

	private log(level: LogLevel, message: string, context?: LogContext): void {
		if (!shouldLog(level, this.level)) return

		const fullContext = { ...this.baseContext, ...context }
		const timestamp = this.showTimestamps ? new Date().toISOString() : ''
		const colorStart = this.useColors ? COLORS[level] : ''
		const colorEnd = this.useColors ? COLORS.reset : ''

		const parts: string[] = []

		if (timestamp) {
			parts.push(`[${timestamp}]`)
		}

		parts.push(`${colorStart}${level.toUpperCase().padEnd(5)}${colorEnd}`)
		parts.push(message)

		if (Object.keys(fullContext).length > 0) {
			parts.push(this.formatContext(fullContext))
		}

		const output = parts.join(' ')

		switch (level) {
			case 'error':
				console.error(output)
				break
			case 'warn':
				console.warn(output)
				break
			default:
				console.log(output)
		}
	}

	private formatContext(context: LogContext): string {
		const entries = Object.entries(context)
			.map(([key, value]) => {
				const formatted = typeof value === 'object'
					? JSON.stringify(value)
					: String(value)
				return `${key}=${formatted}`
			})
			.join(' ')

		return `{ ${entries} }`
	}
}

/**
 * JSON Logger for production (structured output)
 */
export class JsonLogger implements Logger {
	readonly level: LogLevel
	private baseContext: LogContext

	constructor(level: LogLevel, baseContext: LogContext = {}) {
		this.level = level
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
		return new JsonLogger(this.level, { ...this.baseContext, ...context })
	}

	private log(level: LogLevel, message: string, context?: LogContext): void {
		if (!shouldLog(level, this.level)) return

		const entry = {
			timestamp: new Date().toISOString(),
			level,
			message,
			...this.baseContext,
			...context,
		}

		const output = JSON.stringify(entry)

		switch (level) {
			case 'error':
				console.error(output)
				break
			case 'warn':
				console.warn(output)
				break
			default:
				console.log(output)
		}
	}
}
