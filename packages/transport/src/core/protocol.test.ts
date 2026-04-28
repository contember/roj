/**
 * Protocol Definition Tests
 */

import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { defineProtocol, method, notification } from './protocol.js'

describe('Protocol Definition', () => {
	describe('method()', () => {
		it('should create a method definition', () => {
			const def = method({
				input: z.object({ id: z.string() }),
				output: z.object({ success: z.boolean() }),
				error: z.object({ code: z.string() }),
			})

			expect(def._type).toBe('method')
			expect(def.input).toBeDefined()
			expect(def.output).toBeDefined()
			expect(def.error).toBeDefined()
		})
	})

	describe('notification()', () => {
		it('should create a notification definition', () => {
			const def = notification({
				input: z.object({ message: z.string() }),
			})

			expect(def._type).toBe('notification')
			expect(def.input).toBeDefined()
		})
	})

	describe('defineProtocol()', () => {
		const testProtocol = defineProtocol({
			subscribe: method({
				input: z.object({ sessionId: z.string() }),
				output: z.void(),
				error: z.object({ code: z.enum(['SESSION_NOT_FOUND']), message: z.string() }),
			}),
			unsubscribe: method({
				input: z.object({ sessionId: z.string() }),
				output: z.void(),
				error: z.never(),
			}),
			agentMessage: notification({
				input: z.object({
					sessionId: z.string(),
					content: z.string(),
					format: z.enum(['text', 'markdown']),
				}),
			}),
		})

		it('should expose the definition', () => {
			expect(testProtocol._def).toBeDefined()
			expect(testProtocol._def.subscribe).toBeDefined()
			expect(testProtocol._def.unsubscribe).toBeDefined()
			expect(testProtocol._def.agentMessage).toBeDefined()
		})

		describe('getEndpoint()', () => {
			it('should return endpoint definition by name', () => {
				const endpoint = testProtocol.getEndpoint('subscribe')
				expect(endpoint._type).toBe('method')
			})
		})

		describe('isMethod()', () => {
			it('should return true for methods', () => {
				expect(testProtocol.isMethod('subscribe')).toBe(true)
				expect(testProtocol.isMethod('unsubscribe')).toBe(true)
			})

			it('should return false for notifications', () => {
				expect(testProtocol.isMethod('agentMessage')).toBe(false)
			})
		})

		describe('isNotification()', () => {
			it('should return true for notifications', () => {
				expect(testProtocol.isNotification('agentMessage')).toBe(true)
			})

			it('should return false for methods', () => {
				expect(testProtocol.isNotification('subscribe')).toBe(false)
			})
		})

		describe('getMethodNames()', () => {
			it('should return all method names', () => {
				const names = testProtocol.getMethodNames()
				expect(names).toContain('subscribe')
				expect(names).toContain('unsubscribe')
				expect(names).not.toContain('agentMessage')
			})
		})

		describe('getNotificationNames()', () => {
			it('should return all notification names', () => {
				const names = testProtocol.getNotificationNames()
				expect(names).toContain('agentMessage')
				expect(names).not.toContain('subscribe')
			})
		})

		describe('validateInput()', () => {
			it('should validate correct input', () => {
				const result = testProtocol.validateInput('subscribe', { sessionId: 'test-123' })
				expect(result.success).toBe(true)
				if (result.success) {
					expect(result.data.sessionId).toBe('test-123')
				}
			})

			it('should reject invalid input', () => {
				const result = testProtocol.validateInput('subscribe', { sessionId: 123 })
				expect(result.success).toBe(false)
				if (!result.success) {
					expect(result.error.message).toBeDefined()
				}
			})

			it('should reject missing required fields', () => {
				const result = testProtocol.validateInput('subscribe', {})
				expect(result.success).toBe(false)
			})

			it('should validate notification input', () => {
				const result = testProtocol.validateInput('agentMessage', {
					sessionId: 'test',
					content: 'Hello',
					format: 'text',
				})
				expect(result.success).toBe(true)
			})

			it('should reject invalid notification input', () => {
				const result = testProtocol.validateInput('agentMessage', {
					sessionId: 'test',
					content: 'Hello',
					format: 'invalid',
				})
				expect(result.success).toBe(false)
			})
		})

		describe('validateOutput()', () => {
			it('should validate method output', () => {
				const result = testProtocol.validateOutput('subscribe', undefined)
				expect(result.success).toBe(true)
			})

			it('should throw for notification output validation', () => {
				expect(() => testProtocol.validateOutput('agentMessage', {})).toThrow(
					'Endpoint agentMessage is not a method',
				)
			})
		})
	})

	describe('complex schemas', () => {
		it('should handle nested objects', () => {
			const protocol = defineProtocol({
				createUser: method({
					input: z.object({
						name: z.string(),
						address: z.object({
							street: z.string(),
							city: z.string(),
						}),
					}),
					output: z.object({ id: z.string() }),
					error: z.object({ code: z.string() }),
				}),
			})

			const valid = protocol.validateInput('createUser', {
				name: 'John',
				address: { street: '123 Main St', city: 'NYC' },
			})
			expect(valid.success).toBe(true)

			const invalid = protocol.validateInput('createUser', {
				name: 'John',
				address: { street: '123 Main St' }, // Missing city
			})
			expect(invalid.success).toBe(false)
		})

		it('should handle arrays', () => {
			const protocol = defineProtocol({
				sendBatch: method({
					input: z.object({
						messages: z.array(z.object({
							id: z.string(),
							content: z.string(),
						})),
					}),
					output: z.object({ processed: z.number() }),
					error: z.object({ code: z.string() }),
				}),
			})

			const valid = protocol.validateInput('sendBatch', {
				messages: [
					{ id: '1', content: 'Hello' },
					{ id: '2', content: 'World' },
				],
			})
			expect(valid.success).toBe(true)
		})

		it('should handle optional fields', () => {
			const protocol = defineProtocol({
				search: method({
					input: z.object({
						query: z.string(),
						limit: z.number().optional(),
					}),
					output: z.array(z.string()),
					error: z.object({ code: z.string() }),
				}),
			})

			const withOptional = protocol.validateInput('search', { query: 'test', limit: 10 })
			expect(withOptional.success).toBe(true)

			const withoutOptional = protocol.validateInput('search', { query: 'test' })
			expect(withoutOptional.success).toBe(true)
		})
	})
})
