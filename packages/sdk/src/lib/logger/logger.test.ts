import { describe, expect, it } from 'bun:test'
import { serializeError } from './logger.js'

describe('serializeError', () => {
	it('keeps name, message and stack', () => {
		const error = new Error('boom')

		const serialized = serializeError(error)

		expect(serialized.name).toBe('Error')
		expect(serialized.message).toBe('boom')
		expect(serialized.stack).toBeDefined()
	})

	it('omits cause when there is none', () => {
		expect(serializeError(new Error('boom')).cause).toBeUndefined()
	})

	it('serializes an Error cause recursively', () => {
		const error = new Error('outer', { cause: new Error('inner', { cause: new Error('root') }) })

		const serialized = serializeError(error)

		expect(serialized.cause).toMatchObject({ message: 'inner' })
		expect(serialized.cause).toMatchObject({ cause: { message: 'root' } })
	})

	it('describes a non-Error cause', () => {
		expect(serializeError(new Error('a', { cause: 'plain reason' })).cause).toBe('plain reason')
		expect(serializeError(new Error('b', { cause: { code: 'SQLITE_TOOBIG' } })).cause).toBe('{"code":"SQLITE_TOOBIG"}')
		expect(serializeError(new Error('c', { cause: 42 })).cause).toBe('42')
	})

	it('breaks a self-referencing cause', () => {
		const error = new Error('outer')
		error.cause = error

		expect(serializeError(error).cause).toBe('[circular cause]')
	})

	it('breaks a cause cycle between two errors', () => {
		const a = new Error('a')
		const b = new Error('b', { cause: a })
		a.cause = b

		const serialized = serializeError(a)

		expect(serialized.cause).toMatchObject({ message: 'b', cause: '[circular cause]' })
	})

	it('truncates a long cause chain', () => {
		let error = new Error('root')
		for (let i = 0; i < 10; i++) {
			error = new Error(`wrap-${i}`, { cause: error })
		}

		expect(JSON.stringify(serializeError(error))).toContain('[cause chain truncated]')
	})

	it('survives a cause that cannot be read or stringified', () => {
		const throwing = new Error('throwing')
		Object.defineProperty(throwing, 'cause', {
			get() {
				throw new Error('nope')
			},
		})
		expect(serializeError(throwing).cause).toBe('[unreadable cause]')

		const cyclicCause: { self?: unknown } = {}
		cyclicCause.self = cyclicCause
		expect(serializeError(new Error('x', { cause: cyclicCause })).cause).toBe('[unserializable cause]')
	})
})
