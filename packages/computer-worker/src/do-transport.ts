/**
 * The SDK's transport surface, hosted inside the Durable Object.
 *
 * Two halves, both driven by the DO:
 * - **HTTP.** `createApp(services)` is plain Hono, so `POST /rpc` — and every
 *   other route the app mounts — works unmodified once it is handed the in-DO
 *   `SessionManager`. The app is built lazily off `boot`, because the DO boots
 *   the SDK on first use, not in its constructor.
 * - **WebSocket.** `@roj-ai/transport/workers` bridges the DO's class-level
 *   hibernation callbacks onto `ServerAdapter`, which fans notifications out to
 *   the sockets subscribed to each session.
 *
 * The upgrade itself lives here rather than in the transport package:
 * `IWebSocketServer.upgrade` returns a boolean (Bun's shape), and workerd needs
 * a 101 `Response` carrying the client half of a `WebSocketPair`.
 */

import type { Logger, NotificationDelivery, PluginNotification, Services, SessionManager } from '@roj-ai/sdk'
import { ServerAdapter } from '@roj-ai/sdk'
import { createApp } from '@roj-ai/sdk/transport/http/app'
import type { HibernatableWebSocket, WorkersWebSocketHandlers } from '@roj-ai/transport/workers'
import { createWorkersWebSocketHandlers } from '@roj-ai/transport/workers'

/** Path the DO upgrades; everything else is handled by the SDK's Hono app. */
const WS_PATH = '/ws'

/**
 * What the SDK boot produces that the transport needs. Structural on purpose —
 * the DO's own `#boot()` return value satisfies it as-is.
 */
export interface DoTransportHost {
	services: Services<'isolate'>
	system: { sessionManager: SessionManager }
}

/** Stashed with `serializeAttachment` so a socket keeps its subscription across hibernation. */
interface SocketData {
	clientId: string
	sessionId: string | null
}

export interface DoTransport {
	/**
	 * Pass as `onUserOutput` to `createSystemFromServices` — routes each plugin
	 * notification to the sockets subscribed to its session, and answers what
	 * became of it (nothing upstream has to read that, the adapter also logs).
	 */
	readonly broadcast: (notification: PluginNotification) => NotificationDelivery
	/** Mount in `DurableObject.fetch`. Serves `/rpc`, `/health`, `/status`, `/sessions/*` and `GET /ws`. */
	fetch(request: Request): Promise<Response>
	/** Mount in `DurableObject.webSocketMessage`. */
	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void
	/** Mount in `DurableObject.webSocketClose`. */
	webSocketClose(ws: WebSocket, code: number, reason: string): void
	/** Mount in `DurableObject.webSocketError`. */
	webSocketError(ws: WebSocket, error: unknown): void
}

/** Read back what {@link upgrade} attached; a socket with no usable attachment stays unsubscribed. */
function readSocketData(ws: HibernatableWebSocket): SocketData {
	const raw = ws.deserializeAttachment()
	if (typeof raw !== 'object' || raw === null) {
		return { clientId: 'unknown', sessionId: null }
	}
	return {
		clientId: 'clientId' in raw && typeof raw.clientId === 'string' ? raw.clientId : 'unknown',
		sessionId: 'sessionId' in raw && typeof raw.sessionId === 'string' ? raw.sessionId : null,
	}
}

function upgrade(ctx: DurableObjectState, handlers: WorkersWebSocketHandlers<SocketData>, request: Request): Response {
	if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
		return new Response('Expected Upgrade: websocket\n', { status: 426 })
	}

	const pair = new WebSocketPair()
	const client = pair[0]
	const server = pair[1]
	const data: SocketData = {
		clientId: crypto.randomUUID(),
		sessionId: new URL(request.url).searchParams.get('sessionId'),
	}

	// Written before accept so the socket already carries it if the isolate dies immediately.
	server.serializeAttachment(data)
	ctx.acceptWebSocket(server)
	handlers.open(server)

	return new Response(null, { status: 101, webSocket: client })
}

/**
 * Build the DO's transport. `boot` is the DO's own lazy SDK boot — it is called
 * on the first HTTP request, never during hibernation restore.
 *
 * `logger` is not optional the way `ServerAdapterConfig` makes it: sockets open,
 * close and lose frames before anything boots, and an adapter with no logger
 * reports none of it.
 */
export function createDoTransport(ctx: DurableObjectState, boot: () => DoTransportHost, logger: Logger): DoTransport {
	const serverAdapter = new ServerAdapter({ logger })

	const handlers = createWorkersWebSocketHandlers<SocketData>({
		onOpen: (ws) => serverAdapter.handleOpen(ws, ws.data.sessionId ?? undefined),
		onClose: (ws, code, reason) => serverAdapter.handleClose(ws, code, reason),
		onMessage: (ws, message) => serverAdapter.handleMessage(ws, message),
		onError: (ws, error) => serverAdapter.handleError(ws, error),
		getData: readSocketData,
	})

	// Sockets outlive the isolate above them — rebuild their connections before the first frame.
	handlers.restore(ctx.getWebSockets())

	let app: ReturnType<typeof createApp> | undefined
	const getApp = (): ReturnType<typeof createApp> => {
		if (!app) {
			const { services, system } = boot()
			app = createApp({ ...services, sessionRuntime: system.sessionManager })
		}
		return app
	}

	return {
		broadcast: (notification) => serverAdapter.broadcast(notification),

		async fetch(request: Request): Promise<Response> {
			if (new URL(request.url).pathname === WS_PATH) {
				return upgrade(ctx, handlers, request)
			}
			return getApp().fetch(request)
		},

		webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
			handlers.message(ws, message)
		},

		webSocketClose(ws: WebSocket, code: number, reason: string): void {
			handlers.close(ws, code, reason)
		},

		webSocketError(ws: WebSocket, error: unknown): void {
			handlers.error(ws, error)
		},
	}
}
