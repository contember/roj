import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test'
import { ConsoleLogger, JsonLogger } from './console.js'
import type { Logger } from './logger.js'

describe('ConsoleLogger', () => {
	let consoleSpy: {
		log: Mock<typeof console.log>
		warn: Mock<typeof console.warn>
		error: Mock<typeof console.error>
	}

	beforeEach(() => {
		consoleSpy = {
			log: spyOn(console, 'log').mockImplementation(() => {}),
			warn: spyOn(console, 'warn').mockImplementation(() => {}),
			error: spyOn(console, 'error').mockImplementation(() => {}),
		}
	})

	afterEach(() => {
		consoleSpy.log.mockRestore()
		consoleSpy.warn.mockRestore()
		consoleSpy.error.mockRestore()
	})

	describe('log level filtering', () => {
		it('should log messages at or above configured level', () => {
			const logger = new ConsoleLogger({ level: 'info', colors: false, timestamps: false })

			logger.debug('debug message')
			logger.info('info message')
			logger.warn('warn message')
			logger.error('error message')

			// debug should be filtered out (use content-based assertions to avoid flakiness from concurrent test files)
			expect(consoleSpy.log).not.toHaveBeenCalledWith(expect.stringContaining('DEBUG'))
			expect(consoleSpy.log).toHaveBeenCalledWith('INFO  info message')
			expect(consoleSpy.warn).toHaveBeenCalledWith('WARN  warn message')
			expect(consoleSpy.error).toHaveBeenCalledWith('ERROR error message')
		})

		it('should log all messages at debug level', () => {
			const logger = new ConsoleLogger({ level: 'debug', colors: false, timestamps: false })

			logger.debug('debug message')
			logger.info('info message')
			logger.warn('warn message')
			logger.error('error message')

			expect(consoleSpy.log).toHaveBeenCalledWith('DEBUG debug message')
			expect(consoleSpy.log).toHaveBeenCalledWith('INFO  info message')
			expect(consoleSpy.warn).toHaveBeenCalledWith('WARN  warn message')
			expect(consoleSpy.error).toHaveBeenCalledWith('ERROR error message')
		})

		it('should only log errors at error level', () => {
			const logger = new ConsoleLogger({ level: 'error', colors: false, timestamps: false })

			logger.debug('debug message')
			logger.info('info message')
			logger.warn('warn message')
			logger.error('error message')

			expect(consoleSpy.log).not.toHaveBeenCalledWith(expect.stringContaining('DEBUG'))
			expect(consoleSpy.log).not.toHaveBeenCalledWith(expect.stringContaining('INFO'))
			expect(consoleSpy.warn).not.toHaveBeenCalledWith(expect.stringContaining('WARN'))
			expect(consoleSpy.error).toHaveBeenCalledWith('ERROR error message')
		})
	})

	describe('message formatting', () => {
		it('should format message without context', () => {
			const logger = new ConsoleLogger({ level: 'info', colors: false, timestamps: false })

			logger.info('test message')

			expect(consoleSpy.log).toHaveBeenCalledWith('INFO  test message')
		})

		it('should format message with context', () => {
			const logger = new ConsoleLogger({ level: 'info', colors: false, timestamps: false })

			logger.info('test message', { key: 'value', num: 42 })

			expect(consoleSpy.log).toHaveBeenCalledWith('INFO  test message { key=value num=42 }')
		})

		it('should format message with object context', () => {
			const logger = new ConsoleLogger({ level: 'info', colors: false, timestamps: false })

			logger.info('test message', { data: { nested: true } })

			expect(consoleSpy.log).toHaveBeenCalledWith('INFO  test message { data={"nested":true} }')
		})

		it('should include timestamps when enabled', () => {
			const logger = new ConsoleLogger({ level: 'info', colors: false, timestamps: true })

			logger.info('test message')

			const call = consoleSpy.log.mock.calls[0][0] as string
			expect(call).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\] INFO {2}test message$/)
		})

		it('should use correct console method for each level', () => {
			const logger = new ConsoleLogger({ level: 'debug', colors: false, timestamps: false })

			logger.debug('debug')
			logger.info('info')
			logger.warn('warn')
			logger.error('error')

			expect(consoleSpy.log).toHaveBeenCalledWith('DEBUG debug')
			expect(consoleSpy.log).toHaveBeenCalledWith('INFO  info')
			expect(consoleSpy.warn).toHaveBeenCalledWith('WARN  warn')
			expect(consoleSpy.error).toHaveBeenCalledWith('ERROR error')
		})
	})

	describe('error handling', () => {
		it('should include error details in context', () => {
			const logger = new ConsoleLogger({ level: 'error', colors: false, timestamps: false })
			const error = new Error('Something went wrong')

			logger.error('operation failed', error)

			const call = consoleSpy.error.mock.calls[0][0] as string
			expect(call).toContain('ERROR operation failed')
			expect(call).toContain('error={"name":"Error","message":"Something went wrong"')
			expect(call).toContain('stack')
		})

		it('should merge error with existing context', () => {
			const logger = new ConsoleLogger({ level: 'error', colors: false, timestamps: false })
			const error = new Error('test error')

			logger.error('operation failed', error, { userId: '123' })

			const call = consoleSpy.error.mock.calls[0][0] as string
			expect(call).toContain('userId=123')
			expect(call).toContain('error=')
		})
	})

	describe('child loggers', () => {
		it('should create child logger with inherited config', () => {
			const logger = new ConsoleLogger({ level: 'info', colors: false, timestamps: false })
			const child = logger.child({ component: 'test' })

			expect(child.level).toBe('info')
		})

		it('should include parent context in child logs', () => {
			const logger = new ConsoleLogger({ level: 'info', colors: false, timestamps: false }, { app: 'roj' })
			const child = logger.child({ component: 'test' })

			child.info('hello')

			expect(consoleSpy.log).toHaveBeenCalledWith('INFO  hello { app=roj component=test }')
		})

		it('should merge child context with message context', () => {
			const logger = new ConsoleLogger({ level: 'info', colors: false, timestamps: false })
			const child = logger.child({ component: 'test' })

			child.info('hello', { extra: 'data' })

			expect(consoleSpy.log).toHaveBeenCalledWith('INFO  hello { component=test extra=data }')
		})

		it('should allow nested child loggers', () => {
			const logger = new ConsoleLogger({ level: 'info', colors: false, timestamps: false })
			const child1 = logger.child({ level1: 'a' })
			const child2 = child1.child({ level2: 'b' })

			child2.info('nested')

			expect(consoleSpy.log).toHaveBeenCalledWith('INFO  nested { level1=a level2=b }')
		})
	})

	describe('colors', () => {
		it('should include ANSI colors when enabled', () => {
			const logger = new ConsoleLogger({ level: 'info', colors: true, timestamps: false })

			logger.info('colored message')

			const call = consoleSpy.log.mock.calls[0][0] as string
			expect(call).toContain('\x1b[32m') // green
			expect(call).toContain('\x1b[0m') // reset
		})

		it('should not include colors when disabled', () => {
			const logger = new ConsoleLogger({ level: 'info', colors: false, timestamps: false })

			logger.info('plain message')

			const call = consoleSpy.log.mock.calls[0][0] as string
			expect(call).not.toContain('\x1b[')
		})
	})
})

describe('JsonLogger', () => {
	let consoleSpy: {
		log: Mock<typeof console.log>
		warn: Mock<typeof console.warn>
		error: Mock<typeof console.error>
	}

	beforeEach(() => {
		consoleSpy = {
			log: spyOn(console, 'log').mockImplementation(() => {}),
			warn: spyOn(console, 'warn').mockImplementation(() => {}),
			error: spyOn(console, 'error').mockImplementation(() => {}),
		}
	})

	afterEach(() => {
		consoleSpy.log.mockRestore()
		consoleSpy.warn.mockRestore()
		consoleSpy.error.mockRestore()
	})

	describe('log level filtering', () => {
		it('should filter messages below configured level', () => {
			const logger = new JsonLogger('warn')

			logger.debug('debug')
			logger.info('info')
			logger.warn('warn')
			logger.error('error')

			expect(consoleSpy.log).toHaveBeenCalledTimes(0)
			expect(consoleSpy.warn).toHaveBeenCalledTimes(1)
			expect(consoleSpy.error).toHaveBeenCalledTimes(1)
		})
	})

	describe('JSON output', () => {
		it('should output valid JSON', () => {
			const logger = new JsonLogger('info')

			logger.info('test message')

			const call = consoleSpy.log.mock.calls[0][0] as string
			const parsed = JSON.parse(call)
			expect(parsed).toBeDefined()
		})

		it('should include all required fields', () => {
			const logger = new JsonLogger('info')

			logger.info('test message')

			const call = consoleSpy.log.mock.calls[0][0] as string
			const parsed = JSON.parse(call)
			expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
			expect(parsed.level).toBe('info')
			expect(parsed.message).toBe('test message')
		})

		it('should include context in JSON output', () => {
			const logger = new JsonLogger('info')

			logger.info('test message', { key: 'value', count: 5 })

			const call = consoleSpy.log.mock.calls[0][0] as string
			const parsed = JSON.parse(call)
			expect(parsed.key).toBe('value')
			expect(parsed.count).toBe(5)
		})

		it('should use correct console method for each level', () => {
			const logger = new JsonLogger('debug')

			logger.debug('debug')
			logger.info('info')
			logger.warn('warn')
			logger.error('error')

			expect(consoleSpy.log).toHaveBeenCalledTimes(2) // debug + info
			expect(consoleSpy.warn).toHaveBeenCalledTimes(1)
			expect(consoleSpy.error).toHaveBeenCalledTimes(1)
		})
	})

	describe('error handling', () => {
		it('should include error in JSON output', () => {
			const logger = new JsonLogger('error')
			const error = new Error('test error')

			logger.error('failed', error)

			const call = consoleSpy.error.mock.calls[0][0] as string
			const parsed = JSON.parse(call)
			expect(parsed.error.name).toBe('Error')
			expect(parsed.error.message).toBe('test error')
			expect(parsed.error.stack).toBeDefined()
		})

		it('should merge error with context', () => {
			const logger = new JsonLogger('error')
			const error = new Error('test error')

			logger.error('failed', error, { requestId: 'abc' })

			const call = consoleSpy.error.mock.calls[0][0] as string
			const parsed = JSON.parse(call)
			expect(parsed.requestId).toBe('abc')
			expect(parsed.error).toBeDefined()
		})
	})

	describe('child loggers', () => {
		it('should create child logger with inherited level', () => {
			const logger = new JsonLogger('warn')
			const child = logger.child({ service: 'test' })

			expect(child.level).toBe('warn')
		})

		it('should include base context in child logs', () => {
			const logger = new JsonLogger('info', { app: 'roj' })
			const child = logger.child({ component: 'auth' })

			child.info('test')

			const call = consoleSpy.log.mock.calls[0][0] as string
			const parsed = JSON.parse(call)
			expect(parsed.app).toBe('roj')
			expect(parsed.component).toBe('auth')
		})

		it('should allow nested child loggers', () => {
			const logger = new JsonLogger('info')
			const child1 = logger.child({ a: 1 })
			const child2 = child1.child({ b: 2 })

			child2.info('nested')

			const call = consoleSpy.log.mock.calls[0][0] as string
			const parsed = JSON.parse(call)
			expect(parsed.a).toBe(1)
			expect(parsed.b).toBe(2)
		})
	})
})
