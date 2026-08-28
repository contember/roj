/**
 * Heartbeat tests
 *
 * The probe only detects anything if the host answers it and an unanswered run
 * tears the link down. The mock host reads the probe with the same reader
 * `ServerAdapter` uses, so a frame it would refuse is silence here too.
 */

import { describe, expect, it } from 'bun:test'
import type { ICloseEvent, IServerWebSocket, IWebSocket, IWebSocketFactory } from '@roj-ai/transport'
import { WebSocketReadyState } from '@roj-ai/transport'
import { ClientAdapter } from './client-adapter.js'
import { encodeAck, HEARTBEAT_ACK_TYPE, HEARTBEAT_TYPE, isProbeFrame } from './heartbeat.js'
import { ServerAdapter } from './server-adapter.js'

interface WireFrame {
	type: string
	payload: unknown
	ts: number
}

function parseFrames(raw: readonly string[]): WireFrame[] {
	return raw.map((message) => JSON.parse(message))
}

function probeCount(raw: readonly string[]): number {
	return parseFrames(raw).filter((frame) => frame.type === HEARTBEAT_TYPE).length
}

class MockWebSocket implements IWebSocket {
	readyState: WebSocketReadyState = WebSocketReadyState.CONNECTING
	onopen: (() => void) | null = null
	onclose: ((event: ICloseEvent) => void) | null = null
	onerror: ((error: Error) => void) | null = null
	onmessage: ((data: string) => void) | null = null
	readonly sent: string[] = []

	/** Answer every probe this host accepts, until this is cleared. */
	answerProbes = true

	send(data: string): void {
		this.sent.push(data)
		if (!this.answerProbes) return
		if (!isProbeFrame(data)) return
		this.onmessage?.(encodeAck())
	}

	close(code = 1000, reason = ''): void {
		this.readyState = WebSocketReadyState.CLOSED
		this.onclose?.({ code, reason })
	}

	open(): void {
		this.readyState = WebSocketReadyState.OPEN
		this.onopen?.()
	}
}

class MockWsFactory implements IWebSocketFactory {
	readonly sockets: MockWebSocket[] = []

	constructor(private readonly answerProbes: boolean) {}

	create(_url: string): IWebSocket {
		const ws = new MockWebSocket()
		ws.answerProbes = this.answerProbes
		this.sockets.push(ws)
		setTimeout(() => ws.open(), 0)
		return ws
	}

	get latest(): MockWebSocket {
		return this.sockets[this.sockets.length - 1]
	}
}

class MockServerWebSocket implements IServerWebSocket {
	readyState: WebSocketReadyState = WebSocketReadyState.OPEN
	onopen: (() => void) | null = null
	onclose: ((event: ICloseEvent) => void) | null = null
	onerror: ((error: Error) => void) | null = null
	onmessage: ((data: string) => void) | null = null
	data: unknown = undefined
	readonly sent: string[] = []

	send(data: string): void {
		this.sent.push(data)
	}

	close(): void {
		this.readyState = WebSocketReadyState.CLOSED
	}

	subscribe(_topic: string): void {}
	unsubscribe(_topic: string): void {}
	publish(_topic: string, _message: string): void {}
	isSubscribed(_topic: string): boolean {
		return false
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

function createAdapter(factory: MockWsFactory): ClientAdapter {
	return new ClientAdapter({
		url: 'ws://mock',
		wsFactory: factory,
		heartbeatIntervalMs: 5,
		reconnect: { baseDelayMs: 5, maxDelayMs: 10, maxAttempts: Infinity, jitterFactor: 0 },
	})
}

describe('ClientAdapter heartbeat', () => {
	it('holds the connection while the host acks', async () => {
		const factory = new MockWsFactory(true)
		const adapter = createAdapter(factory)
		await adapter.start()

		try {
			await waitFor(() => probeCount(factory.latest.sent) >= 6)
			expect(factory.sockets).toHaveLength(1)
		} finally {
			await adapter.stop()
		}
	})

	it('reconnects once acks stop arriving', async () => {
		const factory = new MockWsFactory(true)
		const adapter = createAdapter(factory)
		await adapter.start()

		try {
			await waitFor(() => factory.latest.sent.length >= 1)
			factory.latest.answerProbes = false

			await waitFor(() => factory.sockets.length >= 2)
			expect(factory.sockets.length).toBeGreaterThanOrEqual(2)
		} finally {
			await adapter.stop()
		}
	})

	it('leaves a host that never acks alone', async () => {
		const factory = new MockWsFactory(false)
		const adapter = createAdapter(factory)
		await adapter.start()

		try {
			await waitFor(() => probeCount(factory.latest.sent) >= 6)
			expect(factory.sockets).toHaveLength(1)
		} finally {
			await adapter.stop()
		}
	})

	it('re-arms per connection, so a silent peer after a reconnect is not torn down', async () => {
		const factory = new MockWsFactory(true)
		const adapter = createAdapter(factory)
		await adapter.start()

		try {
			await waitFor(() => factory.latest.sent.length >= 1)
			factory.latest.answerProbes = false
			await waitFor(() => factory.sockets.length >= 2)

			// The reconnect lands on a host that answers nothing — the arming from the
			// previous peer must not carry over into a teardown loop.
			factory.latest.answerProbes = false
			const socketsAfterReconnect = factory.sockets.length
			await waitFor(() => probeCount(factory.latest.sent) >= 6)

			expect(factory.sockets).toHaveLength(socketsAfterReconnect)
		} finally {
			await adapter.stop()
		}
	})
})

describe('ServerAdapter heartbeat', () => {
	it('answers a probe with an ack and does not route it', () => {
		const adapter = new ServerAdapter()
		const ws = new MockServerWebSocket()
		adapter.handleOpen(ws, 'session-1')
		const routed: string[] = []
		ws.onmessage = (data) => routed.push(data)

		adapter.handleMessage(ws, JSON.stringify({ type: HEARTBEAT_TYPE, payload: { ts: 1 }, ts: 1 }))

		expect(parseFrames(ws.sent).map((frame) => frame.type)).toEqual([HEARTBEAT_ACK_TYPE])
		expect(routed).toHaveLength(0)
	})

	it('does not answer a probe that is not a complete frame', () => {
		const adapter = new ServerAdapter()
		const ws = new MockServerWebSocket()
		adapter.handleOpen(ws, 'session-1')

		adapter.handleMessage(ws, JSON.stringify({ type: HEARTBEAT_TYPE, ts: 1 }))
		adapter.handleMessage(ws, JSON.stringify({ type: HEARTBEAT_TYPE, payload: {}, ts: 1 }))
		adapter.handleMessage(ws, JSON.stringify({ type: HEARTBEAT_TYPE, payload: { ts: 1 } }))

		expect(ws.sent).toHaveLength(0)
	})

	it('routes everything else untouched', () => {
		const adapter = new ServerAdapter()
		const ws = new MockServerWebSocket()
		adapter.handleOpen(ws, 'session-1')
		const routed: string[] = []
		ws.onmessage = (data) => routed.push(data)

		const message = JSON.stringify({ type: 'userMessage', payload: {}, ts: 1 })
		adapter.handleMessage(ws, message)

		expect(routed).toEqual([message])
		expect(ws.sent).toHaveLength(0)
	})
})
