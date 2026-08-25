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
			delete process.env.UPLOAD_ARCHIVE_MAX_ENTRIES
			delete process.env.UPLOAD_ARCHIVE_MAX_UNCOMPRESSED_BYTES
			delete process.env.RESOURCE_ARCHIVE_MAX_ENTRIES
			delete process.env.RESOURCE_ARCHIVE_MAX_UNCOMPRESSED_BYTES
			delete process.env.SESSION_IDLE_TIMEOUT_MS

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
			expect(config.uploadArchiveLimits).toBeUndefined()
			expect(config.resourceArchiveLimits).toBeUndefined()
			// Unset means unset — the default belongs to whichever runtime wants eviction.
			expect(config.sessionIdleTimeoutMs).toBeUndefined()
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
			process.env.UPLOAD_ARCHIVE_MAX_ENTRIES = '750'
			process.env.UPLOAD_ARCHIVE_MAX_UNCOMPRESSED_BYTES = '209715200'
			process.env.RESOURCE_ARCHIVE_MAX_ENTRIES = '2500'
			process.env.RESOURCE_ARCHIVE_MAX_UNCOMPRESSED_BYTES = '1073741824'
			process.env.SESSION_IDLE_TIMEOUT_MS = '0'

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
			expect(config.uploadArchiveLimits).toEqual({
				maxEntries: 750,
				maxTotalUncompressedSize: 209715200,
			})
			expect(config.resourceArchiveLimits).toEqual({
				maxEntries: 2500,
				maxTotalUncompressedSize: 1073741824,
			})
			expect(config.sessionIdleTimeoutMs).toBe(0)
		})

		test('preserves invalid idle timeout input for validation', () => {
			process.env.SESSION_IDLE_TIMEOUT_MS = '1.5'
			const config = loadConfig()
			expect(config.sessionIdleTimeoutMs).toBe(1.5)
			expect(validateConfig(config)).toContain('Invalid sessionIdleTimeoutMs: 1.5')

			process.env.SESSION_IDLE_TIMEOUT_MS = ''
			const emptyConfig = loadConfig()
			expect(emptyConfig.sessionIdleTimeoutMs).toBeNaN()
			expect(validateConfig(emptyConfig)).toContain('Invalid sessionIdleTimeoutMs: NaN')
		})

		test('parses REMOTE_FETCH_ALLOWED_HOSTS into trimmed entries', () => {
			process.env.REMOTE_FETCH_ALLOWED_HOSTS = ' example.internal , 127.0.0.1 ,,'
			expect(loadConfig().remoteFetchAllowedHosts).toEqual(['example.internal', '127.0.0.1'])
		})

		test('leaves the fetch allowlist undefined when unset or empty', () => {
			delete process.env.REMOTE_FETCH_ALLOWED_HOSTS
			expect(loadConfig().remoteFetchAllowedHosts).toBeUndefined()

			// An empty or comma-only value must not read as "allow something".
			process.env.REMOTE_FETCH_ALLOWED_HOSTS = ' , '
			expect(loadConfig().remoteFetchAllowedHosts).toBeUndefined()
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

		test('rejects a fetch allowlist entry that is not a bare host', () => {
			const errors = validateConfig({
				...validConfig,
				remoteFetchAllowedHosts: ['https://example.internal/bucket', 'has space'],
			})
			expect(errors).toContain('Invalid remoteFetchAllowedHosts entry: https://example.internal/bucket')
			expect(errors).toContain('Invalid remoteFetchAllowedHosts entry: has space')
		})

		test('accepts bare hosts and IPv6 literals in the fetch allowlist', () => {
			const errors = validateConfig({
				...validConfig,
				remoteFetchAllowedHosts: ['example.internal', '127.0.0.1', '::1'],
			})
			expect(errors).toHaveLength(0)
		})

		test('accepts a fetch allowlist entry that pins a port', () => {
			const errors = validateConfig({
				...validConfig,
				remoteFetchAllowedHosts: ['127.0.0.1:9000', '[::1]:9000', 'example.internal:8443'],
			})
			expect(errors).toHaveLength(0)
		})

		test('rejects a fetch allowlist entry whose port can never match', () => {
			const errors = validateConfig({
				...validConfig,
				remoteFetchAllowedHosts: ['127.0.0.1:99999', '127.0.0.1:', 'example.internal:http', '[::1'],
			})
			expect(errors).toContain('Invalid remoteFetchAllowedHosts entry: 127.0.0.1:99999')
			expect(errors).toContain('Invalid remoteFetchAllowedHosts entry: 127.0.0.1:')
			expect(errors).toContain('Invalid remoteFetchAllowedHosts entry: example.internal:http')
			expect(errors).toContain('Invalid remoteFetchAllowedHosts entry: [::1')
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

		test('rejects invalid archive limits', () => {
			const config: Config = {
				...validConfig,
				uploadArchiveLimits: { maxEntries: -1 },
				resourceArchiveLimits: { maxTotalUncompressedSize: Number.NaN },
			}

			expect(validateConfig(config)).toEqual([
				'Invalid uploadArchiveLimits.maxEntries: -1',
				'Invalid resourceArchiveLimits.maxTotalUncompressedSize: NaN',
			])
		})

		test('rejects invalid session idle timeouts', () => {
			for (const sessionIdleTimeoutMs of [-1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
				expect(validateConfig({ ...validConfig, sessionIdleTimeoutMs })).toContain(
					`Invalid sessionIdleTimeoutMs: ${sessionIdleTimeoutMs}`,
				)
			}
		})
	})
})
