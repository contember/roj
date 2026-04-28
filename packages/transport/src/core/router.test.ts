/**
 * Message Router Tests
 *
 * Tests for notification-only message router.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { z } from 'zod'
import { defineProtocol, notification } from './protocol.js'
import { createRouter, MessageRouter } from './router.js'

// Test protocols (notification-only)
const receiveProtocol = defineProtocol({
	agentMessage: notification({
		input: z.object({ sessionId: z.string(), content: z.string() }),
	}),
	error: notification({
		input: z.object({ code: z.string(), message: z.string() }),
	}),
})

const sendProtocol = defineProtocol({
	userMessage: notification({
		input: z.object({ sessionId: z.string(), content: z.string() }),
	}),
	status: notification({
		input: z.object({ status: z.string() }),
	}),
})

describe('MessageRouter', () => {
	let router: MessageRouter<typeof receiveProtocol._def, typeof sendProtocol._def>
	let sender: ReturnType<typeof mock>
	let sentMessages: string[]

	beforeEach(() => {
		router = new MessageRouter(receiveProtocol, sendProtocol)
		sentMessages = []
		sender = mock((msg: string) => {
			sentMessages.push(msg)
			return true
		})
		router.setSender(sender)
	})

	afterEach(() => {
		// No cleanup needed - no pending requests in notification-only router
	})

	describe('handleMessage - incoming notifications', () => {
		it('should dispatch notification to handler', async () => {
			const handler = mock().mockResolvedValue(undefined)
			router.setHandlers({ agentMessage: handler })

			await router.handleMessage(
				JSON.stringify({
					type: 'agentMessage',
					payload: { sessionId: 'sess-1', content: 'Hello' },
					ts: Date.now(),
				}),
				{ connectionId: 'conn-1' },
			)

			expect(handler).toHaveBeenCalledWith(
				{ sessionId: 'sess-1', content: 'Hello' },
				{ connectionId: 'conn-1' },
			)
		})

		it('should not send any response for notifications', async () => {
			const handler = mock().mockResolvedValue(undefined)
			router.setHandlers({ agentMessage: handler })

			await router.handleMessage(
				JSON.stringify({
					type: 'agentMessage',
					payload: { sessionId: 'sess-1', content: 'Hello' },
					ts: Date.now(),
				}),
				{ connectionId: 'conn-1' },
			)

			// Notifications don't send responses
			expect(sentMessages.length).toBe(0)
		})

		it('should ignore invalid input without error', async () => {
			const handler = mock().mockResolvedValue(undefined)
			router.setHandlers({ agentMessage: handler })

			await router.handleMessage(
				JSON.stringify({
					type: 'agentMessage',
					payload: { sessionId: 123 }, // Should be string, missing content
					ts: Date.now(),
				}),
				{ connectionId: 'conn-1' },
			)

			// Handler should not be called for invalid input
			expect(handler).not.toHaveBeenCalled()
			// No error response sent (notification-only)
			expect(sentMessages.length).toBe(0)
		})

		it('should ignore messages when no handler registered', async () => {
			// No handlers set

			await router.handleMessage(
				JSON.stringify({
					type: 'agentMessage',
					payload: { sessionId: 'test', content: 'Hello' },
					ts: Date.now(),
				}),
				{ connectionId: 'conn-1' },
			)

			// Should not throw and not send any response
			expect(sentMessages.length).toBe(0)
		})

		it('should silently ignore handler errors', async () => {
			const handler = mock().mockRejectedValue(new Error('Handler failed'))
			router.setHandlers({ agentMessage: handler })

			// Should not throw
			await router.handleMessage(
				JSON.stringify({
					type: 'agentMessage',
					payload: { sessionId: 'test', content: 'Hello' },
					ts: Date.now(),
				}),
				{ connectionId: 'conn-1' },
			)

			expect(handler).toHaveBeenCalled()
			// No error response sent (notification-only)
			expect(sentMessages.length).toBe(0)
		})

		it('should handle multiple notification types', async () => {
			const agentHandler = mock().mockResolvedValue(undefined)
			const errorHandler = mock().mockResolvedValue(undefined)
			router.setHandlers({
				agentMessage: agentHandler,
				error: errorHandler,
			})

			await router.handleMessage(
				JSON.stringify({
					type: 'agentMessage',
					payload: { sessionId: 'sess-1', content: 'Hello' },
					ts: Date.now(),
				}),
				{ connectionId: 'conn-1' },
			)

			await router.handleMessage(
				JSON.stringify({
					type: 'error',
					payload: { code: 'ERR_001', message: 'Something failed' },
					ts: Date.now(),
				}),
				{ connectionId: 'conn-1' },
			)

			expect(agentHandler).toHaveBeenCalledTimes(1)
			expect(errorHandler).toHaveBeenCalledTimes(1)
		})
	})

	describe('notify - outbound notifications', () => {
		it('should send notification', () => {
			router.notify('userMessage', { sessionId: 'test', content: 'Hello' })

			expect(sentMessages.length).toBe(1)
			const message = JSON.parse(sentMessages[0])
			expect(message.type).toBe('userMessage')
			expect(message.payload).toEqual({ sessionId: 'test', content: 'Hello' })
		})

		it('should include timestamp', () => {
			const before = Date.now()
			router.notify('status', { status: 'online' })
			const after = Date.now()

			const message = JSON.parse(sentMessages[0])
			expect(message.ts).toBeGreaterThanOrEqual(before)
			expect(message.ts).toBeLessThanOrEqual(after)
		})

		it('should return true on success', () => {
			const result = router.notify('userMessage', { sessionId: 'test', content: 'Hello' })
			expect(result).toBe(true)
		})

		it('should return false if no sender configured', () => {
			const noSenderRouter = new MessageRouter(receiveProtocol, sendProtocol)
			const result = noSenderRouter.notify('userMessage', { sessionId: 'test', content: 'Hello' })
			expect(result).toBe(false)
		})

		it('should return false if sender returns false', () => {
			const failingRouter = new MessageRouter(receiveProtocol, sendProtocol)
			failingRouter.setSender(() => false)

			const result = failingRouter.notify('userMessage', { sessionId: 'test', content: 'Hello' })
			expect(result).toBe(false)
		})
	})

	describe('createRouter factory', () => {
		it('should create a router instance', () => {
			const router = createRouter(receiveProtocol, sendProtocol)
			expect(router).toBeInstanceOf(MessageRouter)
		})
	})

	describe('invalid JSON handling', () => {
		it('should ignore invalid JSON', async () => {
			const handler = mock()
			router.setHandlers({ agentMessage: handler })

			await router.handleMessage('not valid json', { connectionId: 'test' })

			expect(handler).not.toHaveBeenCalled()
		})
	})

	describe('unknown message types', () => {
		it('should ignore unknown message types', async () => {
			const handler = mock()
			router.setHandlers({ agentMessage: handler })

			await router.handleMessage(
				JSON.stringify({
					type: 'unknownType',
					payload: {},
					ts: Date.now(),
				}),
				{ connectionId: 'test' },
			)

			expect(handler).not.toHaveBeenCalled()
			expect(sentMessages.length).toBe(0)
		})
	})
})
