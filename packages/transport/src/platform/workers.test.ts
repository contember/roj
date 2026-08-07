/**
 * Tests for the Durable Object hibernation WebSocket adapter.
 *
 * Drives it with a fake socket — the platform contract is structural, so no
 * workerd is needed to exercise the parts that differ from Bun (emulated
 * pub/sub, and rebuilding adapters after an isolate restart).
 */

import { describe, expect, it } from 'bun:test'

import type { IServerWebSocket } from './types.js'
import { WebSocketReadyState } from './types.js'
import type { HibernatableWebSocket } from './workers.js'
import { createWorkersWebSocketHandlers } from './workers.js'

interface FakeSocket extends HibernatableWebSocket {
	sent: string[]
	closed: { code?: number; reason?: string } | null
	readyState: number
}

function fakeSocket(attachment: unknown = null): FakeSocket {
	return {
		readyState: WebSocketReadyState.OPEN,
		sent: [],
		closed: null,
		send(message: string) {
			this.sent.push(message)
		},
		close(code?: number, reason?: string) {
			this.closed = { code, reason }
			this.readyState = WebSocketReadyState.CLOSED
		},
		deserializeAttachment() {
			return attachment
		},
	}
}

interface WSData {
	sessionId: string
}

function harness() {
	const opened: IServerWebSocket<WSData>[] = []
	const closed: Array<{ ws: IServerWebSocket<WSData>; code: number; reason: string }> = []
	const messages: Array<{ ws: IServerWebSocket<WSData>; message: string }> = []
	const errors: Error[] = []

	const handlers = createWorkersWebSocketHandlers<WSData>({
		onOpen: (ws) => opened.push(ws),
		onClose: (ws, code, reason) => closed.push({ ws, code, reason }),
		onMessage: (ws, message) => messages.push({ ws, message }),
		onError: (_ws, error) => errors.push(error),
		getData: (ws) => {
			const raw = ws.deserializeAttachment()
			return typeof raw === 'object' && raw !== null && 'sessionId' in raw && typeof raw.sessionId === 'string'
				? { sessionId: raw.sessionId }
				: { sessionId: 'unknown' }
		},
	})

	return { handlers, opened, closed, messages, errors }
}

describe('createWorkersWebSocketHandlers', () => {
	it('opens a socket once and hydrates data from its attachment', () => {
		const { handlers, opened } = harness()
		const ws = fakeSocket({ sessionId: 's1' })

		handlers.open(ws)
		handlers.open(ws)

		expect(opened).toHaveLength(1)
		expect(opened[0]!.data).toEqual({ sessionId: 's1' })
	})

	it('forwards text and binary frames as strings', () => {
		const { handlers, messages } = harness()
		const ws = fakeSocket()
		handlers.open(ws)

		const encoded = new TextEncoder().encode('binary')
		const frame = new ArrayBuffer(encoded.byteLength)
		new Uint8Array(frame).set(encoded)

		handlers.message(ws, 'plain')
		handlers.message(ws, frame)

		expect(messages.map(m => m.message)).toEqual(['plain', 'binary'])
	})

	it('opens a socket lazily when a frame arrives before restore', () => {
		const { handlers, opened, messages } = harness()
		const ws = fakeSocket({ sessionId: 's1' })

		handlers.message(ws, 'early')

		expect(opened).toHaveLength(1)
		expect(messages).toHaveLength(1)
		expect(messages[0]!.ws).toBe(opened[0]!)
	})

	it('normalizes non-Error throwables', () => {
		const { handlers, errors } = harness()
		const ws = fakeSocket()
		handlers.open(ws)

		handlers.error(ws, 'boom')

		expect(errors[0]).toBeInstanceOf(Error)
		expect(errors[0]!.message).toBe('boom')
	})

	it('publishes to topic subscribers except the sender', () => {
		const { handlers, opened } = harness()
		const a = fakeSocket()
		const b = fakeSocket()
		const c = fakeSocket()
		for (const ws of [a, b, c]) handlers.open(ws)

		opened[0]!.subscribe('session:1')
		opened[1]!.subscribe('session:1')
		opened[2]!.subscribe('session:2')

		opened[0]!.publish('session:1', 'hello')

		expect(a.sent).toEqual([])
		expect(b.sent).toEqual(['hello'])
		expect(c.sent).toEqual([])
		expect(opened[1]!.isSubscribed('session:1')).toBe(true)
		expect(opened[2]!.isSubscribed('session:1')).toBe(false)
	})

	it('drops subscriptions when a socket closes', () => {
		const { handlers, opened, closed } = harness()
		const a = fakeSocket()
		const b = fakeSocket()
		handlers.open(a)
		handlers.open(b)
		opened[0]!.subscribe('session:1')
		opened[1]!.subscribe('session:1')

		handlers.close(b, 1000, 'bye')
		handlers.topics.publish('session:1', 'after-close')

		expect(closed).toHaveLength(1)
		expect(b.sent).toEqual([])
		expect(a.sent).toEqual(['after-close'])
	})

	it('does not close twice for the same socket', () => {
		const { handlers, closed } = harness()
		const ws = fakeSocket()
		handlers.open(ws)

		handlers.close(ws, 1000, 'bye')
		handlers.close(ws, 1000, 'bye')

		expect(closed).toHaveLength(1)
	})

	it('restores sockets that outlived the isolate', () => {
		const surviving = [fakeSocket({ sessionId: 's1' }), fakeSocket({ sessionId: 's2' })]

		// A woken DO gets fresh handlers and re-opens whatever state.getWebSockets() returns.
		const { handlers, opened } = harness()
		handlers.restore(surviving)

		expect(opened.map(ws => ws.data.sessionId)).toEqual(['s1', 's2'])
	})

	it('refuses to send on a socket that is no longer open', () => {
		const { handlers, opened } = harness()
		const ws = fakeSocket()
		handlers.open(ws)

		opened[0]!.close(1000, 'done')
		opened[0]!.send('too late')

		expect(ws.closed).toEqual({ code: 1000, reason: 'done' })
		expect(ws.sent).toEqual([])
		expect(opened[0]!.readyState).toBe(WebSocketReadyState.CLOSED)
	})
})
