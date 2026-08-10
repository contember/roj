/**
 * What the adapter says when a notification does not arrive.
 *
 * Every case here used to return `void` and log nothing: the frame went into a
 * send buffer, or off the end of one, and the agent carried on.
 */

import { describe, expect, test } from 'bun:test'
import type { ICloseEvent, IServerWebSocket } from '@roj-ai/transport'
import { WebSocketReadyState } from '@roj-ai/transport'
import type { LogContext, Logger, LogLevel } from '~/lib/logger/logger.js'
import { ServerAdapter } from './server-adapter.js'

interface LogLine {
	level: LogLevel
	message: string
	context?: LogContext
}

/** Records what the adapter logs; `child()` folds its context in, as the real loggers do. */
function recordingLogger(lines: LogLine[], bound: LogContext = {}): Logger {
	const record = (level: LogLevel) => (message: string, context?: LogContext) => {
		lines.push({ level, message, context: { ...bound, ...context } })
	}
	return {
		debug: record('debug'),
		info: record('info'),
		warn: record('warn'),
		error: (message, _error, context) => lines.push({ level: 'error', message, context: { ...bound, ...context } }),
		child: (context) => recordingLogger(lines, { ...bound, ...context }),
		level: 'debug',
	}
}

class FakeSocket implements IServerWebSocket {
	readyState: WebSocketReadyState = WebSocketReadyState.OPEN
	data: unknown = null
	readonly sent: string[] = []
	onopen: (() => void) | null = null
	onclose: ((event: ICloseEvent) => void) | null = null
	onerror: ((error: Error) => void) | null = null
	onmessage: ((data: string) => void) | null = null

	send(data: string): void {
		this.sent.push(data)
	}

	close(): void {
		this.readyState = WebSocketReadyState.CLOSED
	}

	subscribe(): void {}
	unsubscribe(): void {}
	publish(): void {}
	isSubscribed(): boolean {
		return false
	}
}

function connected(sessionId = 'session-1'): { adapter: ServerAdapter; socket: FakeSocket; lines: LogLine[] } {
	const lines: LogLine[] = []
	const adapter = new ServerAdapter({ logger: recordingLogger(lines) })
	const socket = new FakeSocket()
	adapter.handleOpen(socket, sessionId)
	return { adapter, socket, lines }
}

const notification = (content: string) => ({
	pluginName: 'test',
	type: 'test_event',
	payload: { sessionId: 'session-1', content },
})

const warnings = (lines: LogLine[]) => lines.filter((line) => line.level === 'warn')

describe('ServerAdapter.broadcast', () => {
	test('a delivered notification reports its peer and its size', () => {
		const { adapter, socket, lines } = connected()

		const delivery = adapter.broadcast(notification('hello'))

		expect(delivery).toEqual({ bytes: socket.sent[0]!.length, peers: 1, delivered: 1, buffered: 0, dropped: 0 })
		expect(warnings(lines)).toEqual([])
	})

	test('a notification with no sessionId is reported as undeliverable', () => {
		const { adapter, lines } = connected()

		const delivery = adapter.broadcast({ pluginName: 'test', type: 'test_event', payload: { content: 'no session' } })

		expect(delivery).toEqual({ bytes: 0, peers: 0, delivered: 0, buffered: 0, dropped: 0 })
		expect(warnings(lines).map((line) => line.message)).toEqual(['Notification dropped: no sessionId in payload'])
	})

	test('nobody listening is not an error', () => {
		const { adapter, lines } = connected('other-session')

		expect(adapter.broadcast(notification('hello'))).toMatchObject({ peers: 0, delivered: 0 })
		expect(warnings(lines)).toEqual([])
	})

	test('a peer that vanished silently: buffered first, then dropped and warned', () => {
		const { adapter, socket, lines } = connected()
		// Closed without a close callback — what a hibernatable DO socket looks like
		// when the client half goes away. /limits/payload measured 500 / 100 / 0 here.
		socket.readyState = WebSocketReadyState.CLOSED

		let buffered = 0
		let dropped = 0
		for (let i = 0; i < 600; i++) {
			const delivery = adapter.broadcast(notification(`drop-${i}`))
			buffered += delivery.buffered
			dropped += delivery.dropped
		}

		expect({ buffered, dropped, sent: socket.sent.length }).toEqual({ buffered: 500, dropped: 100, sent: 0 })

		const dropWarnings = warnings(lines).filter((line) => line.message === 'Notification discarded: send buffer full')
		expect(dropWarnings).toHaveLength(100)
		expect(dropWarnings[0]?.context).toMatchObject({ component: 'ServerAdapter', type: 'test_event', sessionId: 'session-1', dropped: 1 })
	})

	test('a frame no host may accept is called out before the peer refuses it', () => {
		const { adapter, lines } = connected()

		// 16 MiB is Bun's default maxPayloadLength; workerd closes with 1009 at 32 MiB.
		const delivery = adapter.broadcast(notification('x'.repeat(16 * 1024 * 1024)))

		expect(delivery.bytes).toBeGreaterThan(16 * 1024 * 1024)
		expect(warnings(lines).map((line) => line.message)).toEqual(['Notification frame is larger than a host may accept'])
	})
})

describe('ServerAdapter.handleClose', () => {
	test('1009 says the peer refused a frame for its size', () => {
		const { adapter, socket, lines } = connected()

		adapter.handleClose(socket, 1009, 'Message is too large')

		expect(warnings(lines)).toHaveLength(1)
		expect(warnings(lines)[0]).toMatchObject({ message: 'Client closed the connection: frame too large', context: { code: 1009 } })
	})

	test('a clean close still reports notifications that die with the connection', () => {
		const { adapter, socket, lines } = connected()
		socket.readyState = WebSocketReadyState.CLOSED
		adapter.broadcast(notification('parked'))

		adapter.handleClose(socket, 1000, 'bye')

		expect(warnings(lines)).toHaveLength(1)
		expect(warnings(lines)[0]).toMatchObject({
			message: 'Client disconnected with notifications outstanding',
			context: { code: 1000, undeliveredNotifications: 1, droppedNotifications: 0 },
		})
	})

	test('a clean close with nothing outstanding stays quiet', () => {
		const { adapter, socket, lines } = connected()
		adapter.broadcast(notification('delivered'))

		adapter.handleClose(socket, 1000, 'bye')

		expect(warnings(lines)).toEqual([])
	})
})
