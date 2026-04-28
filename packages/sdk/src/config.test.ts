import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { type Config, loadConfig, validateConfig } from './config.js'

describe('config', () => {
	describe('loadConfig', () => {
		const originalEnv = { ...process.env }

		afterEach(() => {
			// Restore original env
			process.env = { ...originalEnv }
		})

		test('loads default values', () => {
			// Clear relevant env vars
			delete process.env.PORT
			delete process.env.HOST
			delete process.env.DATA_PATH
			delete process.env.PERSISTENCE
			delete process.env.OPENROUTER_API_KEY
			delete process.env.DEFAULT_MODEL
			delete process.env.LOG_LEVEL
			delete process.env.LOG_FORMAT
			delete process.env.WORKER_URL
			delete process.env.AGENT_TOKEN

			const config = loadConfig()

			expect(config.port).toBe(2486)
			expect(config.host).toBe('0.0.0.0')
			expect(config.dataPath).toBe(resolve(process.cwd(), './data'))
			expect(config.persistence).toBe('file')
			expect(config.openRouterApiKey).toBeUndefined()
			expect(config.defaultModel).toBe('anthropic/claude-haiku-4.5')
			expect(config.logLevel).toBe('info')
			expect(config.logFormat).toBe('console')
			expect(config.workerUrl).toBeUndefined()
			expect(config.agentToken).toBeUndefined()
		})

		test('loads values from environment', () => {
			process.env.PORT = '8080'
			process.env.HOST = '127.0.0.1'
			process.env.DATA_PATH = '/var/data'
			process.env.PERSISTENCE = 'memory'
			process.env.OPENROUTER_API_KEY = 'test-api-key'
			process.env.DEFAULT_MODEL = 'gpt-4'
			process.env.LOG_LEVEL = 'debug'
			process.env.LOG_FORMAT = 'json'
			process.env.WORKER_URL = 'https://worker.example.com'
			process.env.AGENT_TOKEN = 'secret-token'

			const config = loadConfig()

			expect(config.port).toBe(8080)
			expect(config.host).toBe('127.0.0.1')
			expect(config.dataPath).toBe('/var/data')
			expect(config.persistence).toBe('memory')
			expect(config.openRouterApiKey).toBe('test-api-key')
			expect(config.defaultModel).toBe('gpt-4')
			expect(config.logLevel).toBe('debug')
			expect(config.logFormat).toBe('json')
			expect(config.workerUrl).toBe('https://worker.example.com')
			expect(config.agentToken).toBe('secret-token')
		})
	})

	describe('validateConfig', () => {
		const validConfig: Config = {
			port: 2486,
			host: '0.0.0.0',
			dataPath: './data',
			persistence: 'file',
			openRouterApiKey: 'test-key',
			defaultModel: 'test-model',
			logLevel: 'info',
			logFormat: 'console',
		}

		test('returns no errors for valid config with API key', () => {
			const errors = validateConfig(validConfig)
			expect(errors).toHaveLength(0)
		})

		test('returns no errors for valid config with mock', () => {
			const config: Config = {
				...validConfig,
				openRouterApiKey: undefined,
				llmMock: () => ({
					content: 'mock',
					toolCalls: [],
					finishReason: 'stop',
					metrics: {
						promptTokens: 0,
						completionTokens: 0,
						totalTokens: 0,
						latencyMs: 0,
						model: 'mock',
					},
				}),
			}
			const errors = validateConfig(config)
			expect(errors).toHaveLength(0)
		})

		test('returns error when no API key and no mock', () => {
			const config: Config = {
				...validConfig,
				openRouterApiKey: undefined,
				anthropicApiKey: undefined,
			}
			const errors = validateConfig(config)
			expect(errors).toContain(
				'At least one of OPENROUTER_API_KEY or ANTHROPIC_API_KEY must be set',
			)
		})

		test('returns error for invalid port', () => {
			const config: Config = {
				...validConfig,
				port: 70000,
			}
			const errors = validateConfig(config)
			expect(errors).toContain('Invalid port number: 70000')
		})

		test('returns error for negative port', () => {
			const config: Config = {
				...validConfig,
				port: -1,
			}
			const errors = validateConfig(config)
			expect(errors).toContain('Invalid port number: -1')
		})

		test('returns error for invalid log level', () => {
			const config: Config = {
				...validConfig,
				logLevel: 'verbose' as any,
			}
			const errors = validateConfig(config)
			expect(errors).toContain('Invalid log level: verbose')
		})

		test('returns error for invalid log format', () => {
			const config: Config = {
				...validConfig,
				logFormat: 'text' as any,
			}
			const errors = validateConfig(config)
			expect(errors).toContain('Invalid log format: text')
		})

		test('returns error for invalid persistence', () => {
			const config: Config = {
				...validConfig,
				persistence: 'sqlite' as any,
			}
			const errors = validateConfig(config)
			expect(errors).toContain('Invalid persistence type: sqlite')
		})

		test('accumulates multiple errors', () => {
			const config: Config = {
				...validConfig,
				openRouterApiKey: undefined,
				port: -1,
				logLevel: 'invalid' as any,
			}
			const errors = validateConfig(config)
			expect(errors.length).toBeGreaterThanOrEqual(3)
		})
	})
})
