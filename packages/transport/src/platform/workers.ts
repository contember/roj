/**
 * Cloudflare Workers WebSocket Adapters
 *
 * Server-side adapter for Durable Object hibernation WebSockets.
 *
 * A DO socket is not an event emitter: after `state.acceptWebSocket(ws)` the
 * runtime delivers events to the DO class (`webSocketMessage`, `webSocketClose`,
 * `webSocketError`), not to the socket. `createWorkersWebSocketHandlers` is the
 * bridge — the DO forwards each class-level event into it, and it fans out to
 * the `IServerWebSocket` callbacks the transport expects.
 *
 * Two things workerd does not give us, both emulated here:
 * - **Pub/sub.** There is no `ws.subscribe`/`ws.publish`; topics live in an
 *   in-memory {@link WorkersTopicRegistry}.
 * - **Continuity across hibernation.** Adapters, topic subscriptions and the
 *   `ServerConnection` objects above them are plain memory and die with the
 *   isolate. The sockets do not — call {@link WorkersWebSocketHandlers.restore}
 *   with `state.getWebSockets()` on wake to rebuild the tree.
 *
 * There is deliberately no client factory here: workerd's `WebSocket` exposes
 * only `addEventListener`, never the `onmessage`/`onclose` properties that
 * `browserWebSocketFactory` assigns, so that adapter is not reusable in a Worker.
 */

import type { ICloseEvent, IServerWebSocket, IWebSocket, IWebSocketFactory } from './types.js'
import { WebSocketReadyState } from './types.js'

/**
 * The part of a Durable Object hibernation WebSocket this adapter touches.
 *
 * Declared structurally rather than imported so `@roj-ai/transport` keeps no
 * dependency on `@cloudflare/workers-types`; workerd's `WebSocket` satisfies it.
 */
export interface HibernatableWebSocket {
	readonly readyState: number
	send(message: string): void
	close(code?: number, reason?: string): void
	/** Whatever the DO stashed at accept time; `unknown` because only the DO knows its shape. */
	deserializeAttachment(): unknown
}

/** Narrow workerd's plain `number` readyState onto the transport's union. */
function toReadyState(value: number): WebSocketReadyState {
	switch (value) {
		case WebSocketReadyState.CONNECTING:
			return WebSocketReadyState.CONNECTING
		case WebSocketReadyState.OPEN:
			return WebSocketReadyState.OPEN
		case WebSocketReadyState.CLOSING:
			return WebSocketReadyState.CLOSING
		default:
			return WebSocketReadyState.CLOSED
	}
}

/**
 * Topic fan-out for a single Durable Object instance.
 *
 * Stands in for Bun's native `ServerWebSocket` pub/sub, which workerd has no
 * equivalent of. Scoped to one DO — cross-DO fan-out is not a transport concern.
 */
export class WorkersTopicRegistry<T = unknown> {
	private readonly byTopic = new Map<string, Set<WorkersServerWebSocketAdapter<T>>>()

	subscribe(adapter: WorkersServerWebSocketAdapter<T>, topic: string): void {
		let subscribers = this.byTopic.get(topic)
		if (!subscribers) {
			subscribers = new Set()
			this.byTopic.set(topic, subscribers)
		}
		subscribers.add(adapter)
	}

	unsubscribe(adapter: WorkersServerWebSocketAdapter<T>, topic: string): void {
		const subscribers = this.byTopic.get(topic)
		if (!subscribers) return
		subscribers.delete(adapter)
		if (subscribers.size === 0) {
			this.byTopic.delete(topic)
		}
	}

	/** Drop an adapter from every topic — call when its socket closes. */
	removeAll(adapter: WorkersServerWebSocketAdapter<T>): void {
		for (const topic of [...this.byTopic.keys()]) {
			this.unsubscribe(adapter, topic)
		}
	}

	/** Send to every subscriber of `topic` except `sender`, matching Bun's semantics. */
	publish(topic: string, message: string, sender?: WorkersServerWebSocketAdapter<T>): void {
		const subscribers = this.byTopic.get(topic)
		if (!subscribers) return
		for (const subscriber of subscribers) {
			if (subscriber === sender) continue
			subscriber.send(message)
		}
	}
}

/**
 * Wraps a Durable Object hibernation WebSocket as an `IServerWebSocket`.
 *
 * The `on*` fields are set by `ServerConnection.attach()` and invoked by the
 * handlers below. `onopen` never fires: a socket is already open by the time
 * the DO accepts it.
 */
export class WorkersServerWebSocketAdapter<T = unknown> implements IServerWebSocket<T> {
	private readonly ws: HibernatableWebSocket
	private readonly registry: WorkersTopicRegistry<T>
	private readonly topics = new Set<string>()

	data: T

	onopen: (() => void) | null = null
	onclose: ((event: ICloseEvent) => void) | null = null
	onerror: ((error: Error) => void) | null = null
	onmessage: ((data: string) => void) | null = null

	constructor(ws: HibernatableWebSocket, data: T, registry: WorkersTopicRegistry<T>) {
		this.ws = ws
		this.data = data
		this.registry = registry
	}

	get readyState(): WebSocketReadyState {
		return toReadyState(this.ws.readyState)
	}

	send(data: string): void {
		if (this.readyState === WebSocketReadyState.OPEN) {
			this.ws.send(data)
		}
	}

	close(code?: number, reason?: string): void {
		this.ws.close(code, reason)
	}

	subscribe(topic: string): void {
		this.topics.add(topic)
		this.registry.subscribe(this, topic)
	}

	unsubscribe(topic: string): void {
		this.topics.delete(topic)
		this.registry.unsubscribe(this, topic)
	}

	publish(topic: string, message: string): void {
		this.registry.publish(topic, message, this)
	}

	isSubscribed(topic: string): boolean {
		return this.topics.has(topic)
	}

	/** Topics this socket is subscribed to — persist these to survive hibernation. */
	getTopics(): ReadonlySet<string> {
		return this.topics
	}

	/**
	 * Get the underlying Durable Object WebSocket (for advanced use cases).
	 */
	getRawWebSocket(): HibernatableWebSocket {
		return this.ws
	}
}

/**
 * Durable Object event forwarders. Each maps 1:1 onto a `DurableObject` method.
 */
export interface WorkersWebSocketHandlers<T> {
	/** Call right after `state.acceptWebSocket(server)`. Idempotent per socket. */
	open(ws: HibernatableWebSocket): void
	/**
	 * Re-open every socket that outlived the isolate — pass `state.getWebSockets()`
	 * from the DO constructor, so connections exist before the first frame arrives.
	 */
	restore(sockets: Iterable<HibernatableWebSocket>): void
	/** Call from `DurableObject.webSocketClose`. */
	close(ws: HibernatableWebSocket, code: number, reason: string): void
	/** Call from `DurableObject.webSocketMessage`. */
	message(ws: HibernatableWebSocket, message: string | ArrayBuffer): void
	/** Call from `DurableObject.webSocketError`. */
	error(ws: HibernatableWebSocket, error: unknown): void
	/** Shared topic registry, for publishing outside of a socket callback. */
	readonly topics: WorkersTopicRegistry<T>
}

/**
 * Create Durable Object WebSocket handlers with adapter integration.
 *
 * `getData` is the rehydration seam: on `restore` the DO has only the raw
 * socket, so it reads back whatever it stashed with `ws.serializeAttachment()`
 * at accept time and validates it into `T` itself.
 */
export function createWorkersWebSocketHandlers<T>(callbacks: {
	onOpen: (ws: IServerWebSocket<T>) => void
	onClose: (ws: IServerWebSocket<T>, code: number, reason: string) => void
	onMessage: (ws: IServerWebSocket<T>, message: string) => void
	onError: (ws: IServerWebSocket<T>, error: Error) => void
	getData: (ws: HibernatableWebSocket) => T
}): WorkersWebSocketHandlers<T> {
	const topics = new WorkersTopicRegistry<T>()
	const adapters = new Map<HibernatableWebSocket, WorkersServerWebSocketAdapter<T>>()
	const decoder = new TextDecoder()

	// An event for an unknown socket means the isolate restarted under it, so open
	// it here too — otherwise the frame would land on an adapter nothing listens to.
	const getOrCreateAdapter = (ws: HibernatableWebSocket): WorkersServerWebSocketAdapter<T> => {
		const known = adapters.get(ws)
		if (known) return known

		const adapter = new WorkersServerWebSocketAdapter(ws, callbacks.getData(ws), topics)
		adapters.set(ws, adapter)
		callbacks.onOpen(adapter)
		return adapter
	}

	return {
		open(ws: HibernatableWebSocket) {
			getOrCreateAdapter(ws)
		},

		close(ws: HibernatableWebSocket, code: number, reason: string) {
			const adapter = adapters.get(ws)
			if (!adapter) return
			callbacks.onClose(adapter, code, reason)
			topics.removeAll(adapter)
			adapters.delete(ws)
		},

		message(ws: HibernatableWebSocket, message: string | ArrayBuffer) {
			const adapter = getOrCreateAdapter(ws)
			const data = typeof message === 'string' ? message : decoder.decode(message)
			callbacks.onMessage(adapter, data)
		},

		error(ws: HibernatableWebSocket, error: unknown) {
			const adapter = getOrCreateAdapter(ws)
			callbacks.onError(adapter, error instanceof Error ? error : new Error(String(error)))
		},

		restore(sockets: Iterable<HibernatableWebSocket>) {
			for (const ws of sockets) {
				getOrCreateAdapter(ws)
			}
		},

		topics,
	}
}

// Re-export types for convenience
export { WebSocketReadyState }
export type { ICloseEvent, IServerWebSocket, IWebSocket, IWebSocketFactory }
