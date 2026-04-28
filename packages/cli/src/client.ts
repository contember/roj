import { RpcClient } from '@roj-ai/shared/rpc'
import type { ProtocolDef, RawMessageListener } from '@roj-ai/transport'
import { bunWebSocketFactory } from '@roj-ai/transport/bun'
import { ClientConnection } from '@roj-ai/transport/client'

export function createCliClient(baseUrl: string): RpcClient {
	return new RpcClient(baseUrl)
}

export type WsConnection = ClientConnection<ProtocolDef, ProtocolDef>

export type NotificationHandlers = Record<string, (payload: unknown) => void>

export function connectWebSocket(
	baseUrl: string,
	sessionId: string,
	handlers: NotificationHandlers,
): WsConnection {
	const url = new URL('/ws/spa', baseUrl)
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	url.searchParams.set('sessionId', sessionId)

	const connection = new ClientConnection<ProtocolDef, ProtocolDef>({
		url: url.toString(),
		wsFactory: bunWebSocketFactory,
		reconnect: {
			baseDelayMs: 1000,
			maxDelayMs: 10000,
			maxAttempts: 10,
		},
	})

	const listener: RawMessageListener = (type, payload) => {
		const handler = handlers[type]
		if (handler) {
			handler(payload)
		}
	}
	connection.setRawMessageListener(listener)
	return connection
}
