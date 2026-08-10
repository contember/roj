/**
 * Logger port - interface pro structured logging
 */

/**
 * Log levels
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Log context - structured metadata
 */
export type LogContext = Record<string, unknown>

/**
 * Logger interface
 */
export interface Logger {
	/**
	 * Debug level - detailní informace pro debugging
	 */
	debug(message: string, context?: LogContext): void

	/**
	 * Info level - běžné informační zprávy
	 */
	info(message: string, context?: LogContext): void

	/**
	 * Warning level - něco není v pořádku, ale není to kritické
	 */
	warn(message: string, context?: LogContext): void

	/**
	 * Error level - chyba, která vyžaduje pozornost
	 */
	error(message: string, error?: Error, context?: LogContext): void

	/**
	 * Vytvoří child logger s předdefinovaným kontextem.
	 * Child logger přidává svůj kontext ke každé zprávě.
	 */
	child(context: LogContext): Logger

	/**
	 * Aktuální log level
	 */
	readonly level: LogLevel
}

/**
 * Logger factory type
 */
export type LoggerFactory = (name: string) => Logger

/**
 * Silent logger - nic neloguje (pro testy)
 */
export const silentLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => silentLogger,
	level: 'error',
}

/**
 * Log level priority (pro filtering)
 */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
}

/**
 * Helper pro porovnání log levels
 */
export const shouldLog = (messageLevel: LogLevel, configuredLevel: LogLevel): boolean =>
	LOG_LEVEL_PRIORITY[messageLevel] >= LOG_LEVEL_PRIORITY[configuredLevel]

/**
 * Serialized error written into log context.
 */
export interface SerializedError {
	name: string
	message: string
	stack?: string
	/** Nested Error, or a description of a non-Error cause */
	cause?: SerializedError | string
}

/** Depth cap for the `cause` chain — long chains are noise, not diagnostics. */
const MAX_CAUSE_DEPTH = 5

/**
 * Flatten an error for structured logging.
 *
 * Includes `cause`, which is where wrapper errors keep the actual reason
 * (EventAppendError says "failed to append", its cause says SQLITE_TOOBIG).
 * Never throws: a cyclic, deep or exotic cause degrades to a placeholder.
 */
export const serializeError = (error: Error): SerializedError => serializeErrorAt(error, new Set(), 0)

const serializeErrorAt = (error: Error, seen: Set<unknown>, depth: number): SerializedError => {
	seen.add(error)

	const serialized: SerializedError = {
		name: error.name,
		message: error.message,
		stack: error.stack,
	}

	const cause = readCause(error)
	if (cause !== undefined) {
		serialized.cause = serializeCause(cause, seen, depth + 1)
	}

	return serialized
}

/** `cause` may be an accessor on a custom Error — reading it must not break logging. */
const readCause = (error: Error): unknown => {
	try {
		return error.cause
	} catch {
		return '[unreadable cause]'
	}
}

const serializeCause = (cause: unknown, seen: Set<unknown>, depth: number): SerializedError | string => {
	if (depth > MAX_CAUSE_DEPTH) return '[cause chain truncated]'
	if (typeof cause === 'object' && cause !== null && seen.has(cause)) return '[circular cause]'
	if (cause instanceof Error) return serializeErrorAt(cause, seen, depth)
	return describeCause(cause)
}

const describeCause = (cause: unknown): string => {
	try {
		if (typeof cause === 'string') return cause
		if (typeof cause === 'object' && cause !== null) return JSON.stringify(cause) ?? String(cause)
		return String(cause)
	} catch {
		return '[unserializable cause]'
	}
}

/**
 * Standardní kontext pro agent operace
 */
export interface AgentLogContext extends LogContext {
	sessionId: string
	agentId: string
	definitionName?: string
}

/**
 * Standardní kontext pro LLM operace
 */
export interface LLMLogContext extends LogContext {
	sessionId: string
	agentId: string
	model: string
	promptTokens?: number
	completionTokens?: number
	latencyMs?: number
}

/**
 * Standardní kontext pro tool operace
 */
export interface ToolLogContext extends LogContext {
	sessionId: string
	agentId: string
	toolName: string
	toolCallId: string
	durationMs?: number
}

/**
 * Shared base for sink-backed loggers.
 *
 * The four level methods and the Error->context flattening in error() were
 * copied verbatim into ConsoleLogger, JsonLogger and FileLogger. The flattening
 * is the part worth having in one place — it is the only path by which a stack
 * trace reaches a structured log, so a sink that misses it drops the field
 * silently.
 *
 * Subclasses supply only log() and child(); child() stays per-class because each
 * returns its own type with its own config. TeeLogger does NOT extend this — it
 * fans out to other loggers rather than writing to a sink.
 */
export abstract class BaseLogger implements Logger {
	abstract readonly level: LogLevel

	protected abstract log(level: LogLevel, message: string, context?: LogContext): void

	abstract child(context: LogContext): Logger

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
		const errorContext = error ? { ...context, error: serializeError(error) } : context

		this.log('error', message, errorContext)
	}
}
