/**
 * ClientConnection reconnect / connect() settlement tests
 *
 * Regression guard: a WebSocket that closes *before it ever opens* must not
 * reject the initial connect() promise while reconnect is still viable. The
 * agent server awaits connect() during boot; rejecting on the first pre-open
 * close crashed the whole process ("Process died") even though it was
 * configured with an infinite-reconnect policy.
 */

import { describe, expect, it } from 'bun:test'

import { ClientConnection } from './client-connection.js'
import type { ICloseEvent, IWebSocket, IWebSocketFactory } from '../platform/types.js'
import { WebSocketReadyState } from '../platform/types.js'

class MockWebSocket implements IWebSocket {
	readyState: WebSocketReadyState = WebSocketReadyState.CONNECTING
	onopen: (() => void) | null = null
	onclose: ((event: ICloseEvent) => void) | null = null
	onerror: ((error: Error) => void) | null = null
	onmessage: ((data: string) => void) | null = null

	send(_data: string): void {}

	close(code = 1000, reason = ''): void {
		this.readyState = WebSocketReadyState.CLOSED
		this.onclose?.({ code, reason })
	}

	simulateOpen(): void {
		this.readyState = WebSocketReadyState.OPEN
		this.onopen?.()
	}

	simulateClose(code: number, reason: string): void {
		this.readyState = WebSocketReadyState.CLOSED
		this.onclose?.({ code, reason })
	}
}

// Factory that fires open/close on the next tick — after ClientConnection has
// wired ws.onopen / ws.onclose in doConnect(). 'close' never opens the socket,
// reproducing a rejected upgrade / immediate server close on connect.
class MockWsFactory implements IWebSocketFactory {
	created = 0
	constructor(private readonly behavior: 'close' | 'open') {}

	create(_url: string): IWebSocket {
		this.created++
		const ws = new MockWebSocket()
		if (this.behavior === 'close') {
			setTimeout(() => ws.simulateClose(1006, 'handshake failed'), 0)
		} else {
			setTimeout(() => ws.simulateOpen(), 0)
		}
		return ws
	}
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('ClientConnection connect() settlement on pre-open close', () => {
	it('keeps connect() pending (no reject) across pre-open closes under infinite reconnect', async () => {
		const factory = new MockWsFactory('close')
		const client = new ClientConnection({
			url: 'ws://mock',
			wsFactory: factory,
			reconnect: { baseDelayMs: 10, maxDelayMs: 20, maxAttempts: Infinity, jitterFactor: 0 },
		})

		let settled: 'resolved' | 'rejected' | null = null
		const reconnecting: number[] = []
		client.on((event, data) => {
			if (event === 'reconnecting') reconnecting.push((data as { attempt: number }).attempt)
		})

		const p = client.connect().then(
			() => { settled = 'resolved' },
			() => { settled = 'rejected' },
		)

		await tick(80)

		// The crash used to happen here: connect() must NOT have rejected yet.
		expect(settled).toBeNull()
		expect(factory.created).toBeGreaterThan(1) // kept retrying
		expect(reconnecting.length).toBeGreaterThan(1)

		// disconnect() is the only thing that settles a still-pending connect()
		await client.disconnect()
		await p
		expect(settled).toBe('rejected')
	})

	it('resolves connect() once a later attempt opens (recovers after transient closes)', async () => {
		// Fails the first two attempts (pre-open close), then opens.
		let attempt = 0
		const factory: IWebSocketFactory = {
			create: () => {
				attempt++
				const ws = new MockWebSocket()
				if (attempt <= 2) {
					setTimeout(() => ws.simulateClose(1006, 'handshake failed'), 0)
				} else {
					setTimeout(() => ws.simulateOpen(), 0)
				}
				return ws
			},
		}
		const client = new ClientConnection({
			url: 'ws://mock',
			wsFactory: factory,
			reconnect: { baseDelayMs: 10, maxDelayMs: 20, maxAttempts: Infinity, jitterFactor: 0 },
		})

		await client.connect()
		expect(client.isConnected()).toBe(true)

		await client.disconnect()
	})

	it('rejects connect() after a finite reconnect budget is exhausted', async () => {
		const factory = new MockWsFactory('close')
		const client = new ClientConnection({
			url: 'ws://mock',
			wsFactory: factory,
			reconnect: { baseDelayMs: 5, maxDelayMs: 10, maxAttempts: 2, jitterFactor: 0 },
		})

		await expect(client.connect()).rejects.toThrow(/Connection closed/)
		expect(factory.created).toBe(3) // initial attempt + 2 reconnects
	})

	it('rejects connect() on the first pre-open close when reconnect is disabled', async () => {
		const factory = new MockWsFactory('close')
		const client = new ClientConnection({
			url: 'ws://mock',
			wsFactory: factory,
			// no reconnect option → reconnect disabled
		})

		await expect(client.connect()).rejects.toThrow(/Connection closed/)
		expect(factory.created).toBe(1)
	})
})
