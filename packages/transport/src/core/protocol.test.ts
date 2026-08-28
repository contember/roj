/**
 * Protocol Definition Tests
 */

import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { defineProtocol, notification } from './protocol.js'

describe('Protocol Definition', () => {
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
			subscribe: notification({
				input: z.object({ sessionId: z.string() }),
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
			expect(testProtocol._def.agentMessage).toBeDefined()
		})

		describe('getNotificationNames()', () => {
			it('should return all notification names', () => {
				const names = testProtocol.getNotificationNames()
				expect(names).toContain('subscribe')
				expect(names).toContain('agentMessage')
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

			it('should reject an invalid enum value', () => {
				const result = testProtocol.validateInput('agentMessage', {
					sessionId: 'test',
					content: 'Hello',
					format: 'invalid',
				})
				expect(result.success).toBe(false)
			})
		})
	})

	describe('complex schemas', () => {
		it('should handle nested objects', () => {
			const protocol = defineProtocol({
				userCreated: notification({
					input: z.object({
						name: z.string(),
						address: z.object({
							street: z.string(),
							city: z.string(),
						}),
					}),
				}),
			})

			const valid = protocol.validateInput('userCreated', {
				name: 'John',
				address: { street: '123 Main St', city: 'NYC' },
			})
			expect(valid.success).toBe(true)

			const invalid = protocol.validateInput('userCreated', {
				name: 'John',
				address: { street: '123 Main St' }, // Missing city
			})
			expect(invalid.success).toBe(false)
		})

		it('should handle arrays', () => {
			const protocol = defineProtocol({
				batchSent: notification({
					input: z.object({
						messages: z.array(z.object({
							id: z.string(),
							content: z.string(),
						})),
					}),
				}),
			})

			const valid = protocol.validateInput('batchSent', {
				messages: [
					{ id: '1', content: 'Hello' },
					{ id: '2', content: 'World' },
				],
			})
			expect(valid.success).toBe(true)
		})

		it('should handle optional fields', () => {
			const protocol = defineProtocol({
				searched: notification({
					input: z.object({
						query: z.string(),
						limit: z.number().optional(),
					}),
				}),
			})

			const withOptional = protocol.validateInput('searched', { query: 'test', limit: 10 })
			expect(withOptional.success).toBe(true)

			const withoutOptional = protocol.validateInput('searched', { query: 'test' })
			expect(withoutOptional.success).toBe(true)
		})
	})
})
