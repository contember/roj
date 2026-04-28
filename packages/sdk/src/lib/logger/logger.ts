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
