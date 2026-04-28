/**
 * Configuration for the Agent Server
 */

import { resolve } from 'node:path'
import type { MockInferenceHandler } from './core/llm/mock.js'
import type { LogLevel } from './lib/logger/logger.js'

/**
 * Server configuration
 */
export interface Config {
	// Server
	port: number
	host: string

	// Persistence
	dataPath: string
	persistence: 'file' | 'memory'

	// LLM — set one or both API keys. When both are set, Anthropic handles claude-* models,
	// OpenRouter handles everything else as fallback.
	openRouterApiKey?: string
	anthropicApiKey?: string
	defaultModel?: string
	llmMock?: MockInferenceHandler
	/** Extended thinking token budget (Anthropic only). When set, enables thinking. */
	thinkingBudget?: number

	// LLM Logging
	llmLoggingEnabled?: boolean

	// Logging
	logLevel: LogLevel
	logFormat: 'console' | 'json'

	// Worker connection (DO mode)
	workerUrl?: string
	agentToken?: string

	// WebSocket configuration
	wsReconnectBaseDelayMs?: number
	wsReconnectMaxDelayMs?: number
	wsHeartbeatIntervalMs?: number
	wsHandshakeTimeoutMs?: number
}

/**
 * Load configuration from environment variables.
 */
export const loadConfig = (): Config => {
	return {
		port: parseInt(process.env.PORT ?? '2486', 10),
		host: process.env.HOST ?? '0.0.0.0',
		dataPath: resolve(process.cwd(), process.env.DATA_PATH ?? './data'),
		persistence: (process.env.PERSISTENCE ?? 'file') as 'file' | 'memory',
		openRouterApiKey: process.env.OPENROUTER_API_KEY,
		anthropicApiKey: process.env.ANTHROPIC_API_KEY,
		defaultModel: process.env.DEFAULT_MODEL ?? 'anthropic/claude-haiku-4.5',
		thinkingBudget: process.env.THINKING_BUDGET ? parseInt(process.env.THINKING_BUDGET, 10) : undefined,
		llmLoggingEnabled: process.env.LLM_LOGGING_ENABLED !== 'false',
		logLevel: (process.env.LOG_LEVEL ?? 'info') as LogLevel,
		logFormat: (process.env.LOG_FORMAT ?? 'console') as 'console' | 'json',
		workerUrl: process.env.WORKER_URL,
		agentToken: process.env.AGENT_TOKEN,
		wsReconnectBaseDelayMs: parseInt(process.env.WS_RECONNECT_BASE_DELAY_MS ?? '1000', 10),
		wsReconnectMaxDelayMs: parseInt(process.env.WS_RECONNECT_MAX_DELAY_MS ?? '30000', 10),
		wsHeartbeatIntervalMs: parseInt(process.env.WS_HEARTBEAT_INTERVAL_MS ?? '30000', 10),
		wsHandshakeTimeoutMs: parseInt(process.env.WS_HANDSHAKE_TIMEOUT_MS ?? '10000', 10),
	}
}

/**
 * Validate configuration and return errors if any.
 */
export const validateConfig = (config: Config): string[] => {
	const errors: string[] = []

	if (!config.llmMock && !config.openRouterApiKey && !config.anthropicApiKey) {
		errors.push('At least one of OPENROUTER_API_KEY or ANTHROPIC_API_KEY must be set')
	}

	if (config.port < 0 || config.port > 65535) {
		errors.push(`Invalid port number: ${config.port}`)
	}

	const validLogLevels = ['debug', 'info', 'warn', 'error']
	if (!validLogLevels.includes(config.logLevel)) {
		errors.push(`Invalid log level: ${config.logLevel}`)
	}

	const validLogFormats = ['console', 'json']
	if (!validLogFormats.includes(config.logFormat)) {
		errors.push(`Invalid log format: ${config.logFormat}`)
	}

	const validPersistence = ['file', 'memory']
	if (!validPersistence.includes(config.persistence)) {
		errors.push(`Invalid persistence type: ${config.persistence}`)
	}

	return errors
}
