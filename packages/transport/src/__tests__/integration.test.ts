/**
 * Integration Tests for Transport Package
 *
 * These tests run actual WebSocket server and client to verify
 * real-world communication scenarios with notification-only protocol.
 */

import type { Server } from 'bun'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import { ClientConnection } from '../client/client-connection.js'
import { defineProtocol, notification } from '../core/protocol.js'
import { BunServerWebSocketAdapter, bunWebSocketFactory, createBunWebSocketHandlers } from '../platform/bun.js'
import type { IServerWebSocket } from '../platform/types.js'
import { ServerConnection } from '../server/server-connection.js'

// ============================================================================
// Test Protocols (notification-only)
// ============================================================================

// Client -> Server (notifications)
const clientProtocol = defineProtocol({
	userMessage: notification({
		input: z.object({ sessionId: z.string(), content: z.string() }),
	}),
	userStatus: notification({
		input: z.object({ status: z.enum(['online', 'away', 'offline']) }),
	}),
})

// Server -> Client (notifications)
const serverProtocol = defineProtocol({
	serverEvent: notification({
		input: z.object({ eventType: z.string(), data: z.unknown() }),
	}),
	agentMessage: notification({
		input: z.object({ sessionId: z.string(), content: z.string() }),
	}),
})

// ============================================================================
// Test Server Setup
// ============================================================================

interface TestServerState {
	server: Server
	port: number
	connections: Map<string, ServerConnection<typeof clientProtocol._def, typeof serverProtocol._def>>
	receivedNotifications: Array<{ type: string; input: unknown }>
}

function createTestServer(): Promise<TestServerState> {
	return new Promise((resolve) => {
		const connections = new Map<string, ServerConnection<typeof clientProtocol._def, typeof serverProtocol._def>>()
		const receivedNotifications: Array<{ type: string; input: unknown }> = []

		const wsHandlers = createBunWebSocketHandlers({
			onOpen: (ws: IServerWebSocket) => {
				const serverConn = new ServerConnection({
					receiveProtocol: clientProtocol,
					sendProtocol: serverProtocol,
				})

				// Set up handlers for incoming notifications
				serverConn.setHandlers({
					userMessage: async (input) => {
						receivedNotifications.push({ type: 'userMessage', input })
					},
					userStatus: async (input) => {
						receivedNotifications.push({ type: 'userStatus', input })
					},
				})

				serverConn.attach(ws)
				connections.set(serverConn.getConnectionId(), serverConn)
				;(ws as unknown as { __serverConn: ServerConnection<typeof clientProtocol._def, typeof serverProtocol._def> }).__serverConn = serverConn
			},
			onClose: (ws: IServerWebSocket) => {
				const serverConn = (ws as unknown as { __serverConn: ServerConnection<typeof clientProtocol._def, typeof serverProtocol._def> }).__serverConn
				if (serverConn) {
					connections.delete(serverConn.getConnectionId())
				}
			},
			onMessage: (ws: IServerWebSocket, message: string) => {
				// Forward message to the WebSocket's onmessage handler
				ws.onmessage?.(message)
			},
			onError: () => {},
			getData: () => ({}),
		})

		const server = Bun.serve({
			port: 0, // Random available port
			fetch(req, server) {
				if (server.upgrade(req)) {
					return
				}
				return new Response('WebSocket server', { status: 200 })
			},
			websocket: {
				open: wsHandlers.open,
				close: wsHandlers.close,
				message: wsHandlers.message,
			},
		})

		resolve({
			server,
			port: server.port,
			connections,
			receivedNotifications,
		})
	})
}

// ============================================================================
// Integration Tests
// ============================================================================

describe('Transport Integration Tests', () => {
	let testServer: TestServerState

	beforeAll(async () => {
		testServer = await createTestServer()
	})

	afterAll(() => {
		testServer.server.stop()
	})

	afterEach(() => {
		testServer.receivedNotifications.length = 0
	})

	describe('Connection', () => {
		it('should connect successfully', async () => {
			const client = new ClientConnection({
				url: `ws://localhost:${testServer.port}`,
				wsFactory: bunWebSocketFactory,
				receiveProtocol: serverProtocol,
				sendProtocol: clientProtocol,
			})

			await client.connect()

			expect(client.isConnected()).toBe(true)
			expect(client.getState()).toBe('connected')

			await client.disconnect()
			expect(client.isConnected()).toBe(false)
		})

		it('should emit state change events', async () => {
			const stateChanges: Array<{ from: string; to: string }> = []

			const client = new ClientConnection({
				url: `ws://localhost:${testServer.port}`,
				wsFactory: bunWebSocketFactory,
				receiveProtocol: serverProtocol,
				sendProtocol: clientProtocol,
			})

			client.on((event, data) => {
				if (event === 'state_change') {
					stateChanges.push(data as { from: string; to: string })
				}
			})

			await client.connect()
			await client.disconnect()

			// Should have state changes: disconnected -> connecting -> connected -> disconnected
			expect(stateChanges.length).toBeGreaterThan(2)
			expect(stateChanges.some((s) => s.to === 'connected')).toBe(true)
		})
	})

	describe('Client-to-Server Notifications', () => {
		it('should send notification to server', async () => {
			const client = new ClientConnection({
				url: `ws://localhost:${testServer.port}`,
				wsFactory: bunWebSocketFactory,
				receiveProtocol: serverProtocol,
				sendProtocol: clientProtocol,
			})

			await client.connect()

			// Send notification
			client.notify.userMessage({ sessionId: 'sess-1', content: 'Hello World' })

			// Wait for notification to arrive
			await new Promise((resolve) => setTimeout(resolve, 50))

			// Verify server received the notification
			expect(testServer.receivedNotifications).toContainEqual({
				type: 'userMessage',
				input: { sessionId: 'sess-1', content: 'Hello World' },
			})

			await client.disconnect()
		})

		it('should send multiple notifications', async () => {
			const client = new ClientConnection({
				url: `ws://localhost:${testServer.port}`,
				wsFactory: bunWebSocketFactory,
				receiveProtocol: serverProtocol,
				sendProtocol: clientProtocol,
			})

			await client.connect()

			// Send multiple notifications
			client.notify.userMessage({ sessionId: 'sess-1', content: 'First message' })
			client.notify.userStatus({ status: 'online' })
			client.notify.userMessage({ sessionId: 'sess-1', content: 'Second message' })

			// Wait for notifications to arrive
			await new Promise((resolve) => setTimeout(resolve, 50))

			expect(testServer.receivedNotifications.length).toBe(3)
			expect(testServer.receivedNotifications[0]).toEqual({
				type: 'userMessage',
				input: { sessionId: 'sess-1', content: 'First message' },
			})
			expect(testServer.receivedNotifications[1]).toEqual({
				type: 'userStatus',
				input: { status: 'online' },
			})
			expect(testServer.receivedNotifications[2]).toEqual({
				type: 'userMessage',
				input: { sessionId: 'sess-1', content: 'Second message' },
			})

			await client.disconnect()
		})
	})

	describe('Server-to-Client Notifications', () => {
		it('should receive notifications from server', async () => {
			const receivedNotifications: Array<{ eventType: string; data: unknown }> = []

			const client = new ClientConnection({
				url: `ws://localhost:${testServer.port}`,
				wsFactory: bunWebSocketFactory,
				receiveProtocol: serverProtocol,
				sendProtocol: clientProtocol,
			})

			// Set up notification handler
			client.setHandlers({
				serverEvent: async (input) => {
					receivedNotifications.push(input)
				},
			})

			await client.connect()

			// Get the server connection and send notification
			await new Promise((resolve) => setTimeout(resolve, 50)) // Wait for server to register connection

			const serverConnections = Array.from(testServer.connections.values())
			expect(serverConnections.length).toBeGreaterThan(0)

			const serverConn = serverConnections[0]
			serverConn.notify.serverEvent({ eventType: 'test_event', data: { foo: 'bar' } })

			// Wait for notification to arrive
			await new Promise((resolve) => setTimeout(resolve, 50))

			expect(receivedNotifications.length).toBe(1)
			expect(receivedNotifications[0].eventType).toBe('test_event')
			expect(receivedNotifications[0].data).toEqual({ foo: 'bar' })

			await client.disconnect()
		})

		it('should receive agent messages from server', async () => {
			const receivedMessages: Array<{ sessionId: string; content: string }> = []

			const client = new ClientConnection({
				url: `ws://localhost:${testServer.port}`,
				wsFactory: bunWebSocketFactory,
				receiveProtocol: serverProtocol,
				sendProtocol: clientProtocol,
			})

			client.setHandlers({
				agentMessage: async (input) => {
					receivedMessages.push(input)
				},
			})

			await client.connect()
			await new Promise((resolve) => setTimeout(resolve, 50))

			const serverConnections = Array.from(testServer.connections.values())
			const serverConn = serverConnections[0]

			serverConn.notify.agentMessage({ sessionId: 'sess-1', content: 'Hello from agent!' })

			await new Promise((resolve) => setTimeout(resolve, 50))

			expect(receivedMessages.length).toBe(1)
			expect(receivedMessages[0]).toEqual({ sessionId: 'sess-1', content: 'Hello from agent!' })

			await client.disconnect()
		})
	})

	describe('Reconnection', () => {
		it('should attempt reconnection when connection is lost', async () => {
			const reconnectAttempts: number[] = []
			const stateChanges: string[] = []

			// Create a server that immediately closes connections
			const tempServer = Bun.serve({
				port: 0,
				fetch(req, server) {
					if (server.upgrade(req)) return
					return new Response('ok')
				},
				websocket: {
					open(ws) {
						// Close connection after a brief delay to trigger reconnect
						setTimeout(() => ws.close(1000, 'Server initiated close'), 50)
					},
					message() {},
					close() {},
				},
			})

			const client = new ClientConnection({
				url: `ws://localhost:${tempServer.port}`,
				wsFactory: bunWebSocketFactory,
				receiveProtocol: serverProtocol,
				sendProtocol: clientProtocol,
				reconnect: {
					baseDelayMs: 20,
					maxDelayMs: 100,
					maxAttempts: 2,
					jitterFactor: 0,
				},
			})

			client.on((event, data) => {
				if (event === 'reconnecting') {
					reconnectAttempts.push((data as { attempt: number }).attempt)
				}
				if (event === 'state_change') {
					stateChanges.push((data as { to: string }).to)
				}
			})

			await client.connect()

			// Wait for server to close connection and client to attempt reconnect
			await new Promise((resolve) => setTimeout(resolve, 200))

			// Should have attempted reconnection
			expect(reconnectAttempts.length).toBeGreaterThan(0)
			expect(stateChanges).toContain('reconnecting')

			await client.disconnect()
			tempServer.stop()
		})
	})

	describe('Multiple Clients', () => {
		it('should handle multiple simultaneous clients', async () => {
			const numClients = 5
			const clients: ClientConnection<typeof serverProtocol._def, typeof clientProtocol._def>[] = []

			// Connect multiple clients
			for (let i = 0; i < numClients; i++) {
				const client = new ClientConnection({
					url: `ws://localhost:${testServer.port}`,
					wsFactory: bunWebSocketFactory,
					receiveProtocol: serverProtocol,
					sendProtocol: clientProtocol,
				})
				await client.connect()
				clients.push(client)
			}

			// All clients should be connected
			expect(clients.every((c) => c.isConnected())).toBe(true)

			// Each client sends a notification
			clients.forEach((client, i) => {
				client.notify.userMessage({ sessionId: `sess-${i}`, content: `Message from client ${i}` })
			})

			// Wait for notifications to arrive
			await new Promise((resolve) => setTimeout(resolve, 100))

			// All notifications should be received
			expect(testServer.receivedNotifications.length).toBe(numClients)

			// Disconnect all
			await Promise.all(clients.map((c) => c.disconnect()))
		})
	})

	describe('Bidirectional Communication', () => {
		it('should handle simultaneous send and receive', async () => {
			const clientReceivedMessages: unknown[] = []

			const client = new ClientConnection({
				url: `ws://localhost:${testServer.port}`,
				wsFactory: bunWebSocketFactory,
				receiveProtocol: serverProtocol,
				sendProtocol: clientProtocol,
			})

			client.setHandlers({
				agentMessage: async (input) => {
					clientReceivedMessages.push(input)
				},
			})

			await client.connect()
			await new Promise((resolve) => setTimeout(resolve, 50))

			// Client sends notification
			client.notify.userMessage({ sessionId: 'sess-1', content: 'Client message' })

			// Server sends notification simultaneously
			const serverConnections = Array.from(testServer.connections.values())
			serverConnections[0].notify.agentMessage({ sessionId: 'sess-1', content: 'Server message' })

			await new Promise((resolve) => setTimeout(resolve, 100))

			// Both sides should have received notifications
			expect(testServer.receivedNotifications.some((n) => n.type === 'userMessage')).toBe(true)
			expect(clientReceivedMessages.length).toBe(1)

			await client.disconnect()
		})
	})
})
