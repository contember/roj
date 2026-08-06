import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from 'bun:test'
import { Connection } from './connection.js'
import type { ProtocolDef } from './protocol.js'
import type { ICloseEvent, IWebSocket } from '../platform/types.js'
import { WebSocketReadyState } from '../platform/types.js'

class RecordingWebSocket implements IWebSocket {
	readyState: WebSocketReadyState = WebSocketReadyState.OPEN
	onopen: (() => void) | null = null
	onclose: ((event: ICloseEvent) => void) | null = null
	onerror: ((error: Error) => void) | null = null
	onmessage: ((data: string) => void) | null = null
	readonly sent: string[] = []

	send(data: string): void {
		this.sent.push(data)
	}

	close(): void {
		this.readyState = WebSocketReadyState.CLOSED
	}
}

class TestConnection extends Connection<ProtocolDef, ProtocolDef> {
	async connect(): Promise<void> {}
	async disconnect(): Promise<void> {}

	attach(ws: IWebSocket): void {
		this.setupWebSocket(ws)
		this.handleOpen()
		this.flushSendBuffer()
	}
}

let warnSpy: Mock<typeof console.warn>

beforeEach(() => {
	warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
	warnSpy.mockRestore()
})

describe('Connection send buffer', () => {
	it('keeps the newest messages and reports one overflow episode', () => {
		const connection = new TestConnection({})

		for (let index = 0; index < 503; index++) {
			connection.send(`message-${index}`)
		}

		expect(connection.bufferedMessageCount).toBe(500)
		expect(warnSpy).toHaveBeenCalledTimes(1)
		expect(warnSpy).toHaveBeenCalledWith(
			'[transport] send buffer full (500), dropping oldest notifications',
		)

		const ws = new RecordingWebSocket()
		connection.attach(ws)

		expect(ws.sent).toHaveLength(500)
		expect(ws.sent[0]).toBe('message-3')
		expect(ws.sent.at(-1)).toBe('message-502')
		expect(connection.bufferedMessageCount).toBe(0)
		expect(warnSpy).toHaveBeenCalledTimes(2)
		expect(warnSpy).toHaveBeenLastCalledWith(
			'[transport] send buffer drained; 3 notification(s) were dropped',
		)
	})

	it('starts a new warning episode after the previous buffer drains', () => {
		const connection = new TestConnection({})

		for (let index = 0; index < 501; index++) connection.send(`first-${index}`)
		connection.attach(new RecordingWebSocket())

		const disconnected = new TestConnection({})
		for (let index = 0; index < 501; index++) disconnected.send(`second-${index}`)

		expect(
			warnSpy.mock.calls.filter(([message]) => String(message).includes('send buffer full')),
		).toHaveLength(2)
	})
})
