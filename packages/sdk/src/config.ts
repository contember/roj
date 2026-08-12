/**
 * Configuration for the Agent Server
 */

import { resolve } from 'node:path'
import type { MockInferenceHandler } from './core/llm/mock.js'
import type { ArchiveLimitOverrides } from './lib/archive/index.js'
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

	/** Max concurrent vision LLM calls when classifying uploaded images. Default 10. */
	imageClassifierConcurrency?: number

	/** Aggregate limits across every ZIP nested in one attachment upload. */
	uploadArchiveLimits?: ArchiveLimitOverrides
	/** Per-archive limits for resource ZIP injection. */
	resourceArchiveLimits?: ArchiveLimitOverrides

	/**
	 * Identity of the application embedding this SDK. Reported via `/status`
	 * so platform health-checks can surface "what's actually running" in debug
	 * tooling alongside the SDK's own version.
	 *
	 * sandbox-runtime sets this from its own package.json; other embedders
	 * (e.g. standalone-server, custom bundles) can supply their own.
	 */
	agentRuntime?: {
		name: string
		version: string
	}

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
		imageClassifierConcurrency: process.env.IMAGE_CLASSIFIER_CONCURRENCY
			? parseInt(process.env.IMAGE_CLASSIFIER_CONCURRENCY, 10)
			: undefined,
		uploadArchiveLimits: archiveLimitsFromEnv('UPLOAD_ARCHIVE'),
		resourceArchiveLimits: archiveLimitsFromEnv('RESOURCE_ARCHIVE'),
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

	validateArchiveLimitOverrides('uploadArchiveLimits', config.uploadArchiveLimits, errors)
	validateArchiveLimitOverrides('resourceArchiveLimits', config.resourceArchiveLimits, errors)

	return errors
}

function archiveLimitsFromEnv(prefix: 'UPLOAD_ARCHIVE' | 'RESOURCE_ARCHIVE'): ArchiveLimitOverrides | undefined {
	const maxEntries = process.env[`${prefix}_MAX_ENTRIES`]
	const maxTotalUncompressedSize = process.env[`${prefix}_MAX_UNCOMPRESSED_BYTES`]
	if (maxEntries === undefined && maxTotalUncompressedSize === undefined) return undefined
	return {
		maxEntries: maxEntries === undefined ? undefined : parseInt(maxEntries, 10),
		maxTotalUncompressedSize: maxTotalUncompressedSize === undefined
			? undefined
			: parseInt(maxTotalUncompressedSize, 10),
	}
}

function validateArchiveLimitOverrides(
	name: 'uploadArchiveLimits' | 'resourceArchiveLimits',
	limits: ArchiveLimitOverrides | undefined,
	errors: string[],
): void {
	if (!limits) return
	for (const [field, value] of Object.entries(limits)) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
			errors.push(`Invalid ${name}.${field}: ${value}`)
		}
	}
}
