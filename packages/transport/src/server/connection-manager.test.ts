/**
 * What a broadcast reports.
 *
 * The interesting case is the peer that is gone without the server hearing about
 * it: its frames pile up in the send buffer and, past the cap, vanish. Before
 * `BroadcastResult` the caller saw the same "0 delivered" either way.
 */

import { describe, expect, test } from 'bun:test'
import type { ICloseEvent, IServerWebSocket } from '../platform/types.js'
import { WebSocketReadyState } from '../platform/types.js'
import { ConnectionManager } from './connection-manager.js'
import { ServerConnection } from './server-connection.js'
import type { ProtocolDef } from '../core/protocol.js'

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

function subscribed(manager: ConnectionManager, sessionId: string): { connection: ServerConnection<ProtocolDef, ProtocolDef>; socket: FakeSocket } {
	const connection = new ServerConnection<ProtocolDef, ProtocolDef>({})
	const socket = new FakeSocket()
	connection.attach(socket)
	manager.add(connection)
	manager.subscribe(connection.getConnectionId(), sessionId)
	return { connection, socket }
}

describe('ConnectionManager.broadcast', () => {
	test('reports every subscriber it reached', () => {
		const manager = new ConnectionManager()
		const { socket } = subscribed(manager, 's1')

		expect(manager.broadcast('s1', 'hello')).toEqual({ subscribers: 1, delivered: 1, buffered: 0, dropped: 0 })
		expect(socket.sent).toEqual(['hello'])
	})

	test('no subscriber is not the same answer as no delivery', () => {
		const manager = new ConnectionManager()
		const { socket } = subscribed(manager, 's1')
		socket.readyState = WebSocketReadyState.CLOSED

		expect(manager.broadcast('nobody', 'x')).toEqual({ subscribers: 0, delivered: 0, buffered: 0, dropped: 0 })
		expect(manager.broadcast('s1', 'x')).toEqual({ subscribers: 1, delivered: 0, buffered: 1, dropped: 0 })
	})

	test('a full send buffer is reported as loss, not as silence', () => {
		const manager = new ConnectionManager()
		const { connection, socket } = subscribed(manager, 's1')
		// The peer is gone but nothing told the server — the shape /limits/payload measures.
		socket.readyState = WebSocketReadyState.CLOSED

		let buffered = 0
		let dropped = 0
		for (let i = 0; i < 600; i++) {
			const result = manager.broadcast('s1', `n-${i}`)
			buffered += result.buffered
			dropped += result.dropped
		}

		expect(buffered).toBe(500)
		expect(dropped).toBe(100)
		expect(connection.bufferedMessageCount).toBe(500)
		expect(connection.droppedMessageCount).toBe(100)
	})

	test('a socket that throws buffers rather than losing the frame outright', () => {
		const manager = new ConnectionManager()
		const { connection, socket } = subscribed(manager, 's1')
		socket.send = () => {
			throw new Error('backpressure')
		}

		expect(manager.broadcast('s1', 'x')).toEqual({ subscribers: 1, delivered: 0, buffered: 1, dropped: 0 })
		expect(connection.bufferedMessageCount).toBe(1)
	})
})
