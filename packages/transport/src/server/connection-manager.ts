/**
 * Connection Manager
 *
 * Manages multiple WebSocket connections and session subscriptions.
 */

import type { ProtocolDef } from '../core/protocol.js'
import type { ServerConnection } from './server-connection.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Connection statistics.
 */
export interface ConnectionStats {
	/** Total number of connections */
	totalConnections: number
	/** Number of active (connected) connections */
	activeConnections: number
	/** Number of unique sessions with subscribers */
	activeSessions: number
	/** Connections by client type */
	byClientType: Record<string, number>
}

// ============================================================================
// Connection Manager
// ============================================================================

/**
 * Manages multiple server connections and session subscriptions.
 *
 * Features:
 * - Track all active connections
 * - Manage session subscriptions
 * - Broadcast to subscribed connections
 * - Connection statistics
 */
export class ConnectionManager<
	TReceive extends ProtocolDef = ProtocolDef,
	TSend extends ProtocolDef = ProtocolDef,
> {
	private connections = new Map<string, ServerConnection<TReceive, TSend>>()
	private sessionSubscriptions = new Map<string, Set<string>>() // sessionId -> connectionIds

	// ============================================================================
	// Connection Management
	// ============================================================================

	/**
	 * Add a connection.
	 */
	add(connection: ServerConnection<TReceive, TSend>): void {
		this.connections.set(connection.getConnectionId(), connection)
	}

	/**
	 * Remove a connection.
	 */
	remove(connectionId: string): void {
		const connection = this.connections.get(connectionId)
		if (!connection) return

		// Clean up subscriptions
		for (const sessionId of connection.getSubscribedSessions()) {
			this.unsubscribeInternal(connectionId, sessionId)
		}

		this.connections.delete(connectionId)
	}

	/**
	 * Get a connection by ID.
	 */
	get(connectionId: string): ServerConnection<TReceive, TSend> | undefined {
		return this.connections.get(connectionId)
	}

	/**
	 * Check if a connection exists.
	 */
	has(connectionId: string): boolean {
		return this.connections.has(connectionId)
	}

	/**
	 * Get all connections.
	 */
	getAll(): Iterable<ServerConnection<TReceive, TSend>> {
		return this.connections.values()
	}

	/**
	 * Get all connection IDs.
	 */
	getAllIds(): Iterable<string> {
		return this.connections.keys()
	}

	/**
	 * Get connection count.
	 */
	get size(): number {
		return this.connections.size
	}

	// ============================================================================
	// Session Subscriptions
	// ============================================================================

	/**
	 * Subscribe a connection to a session.
	 */
	subscribe(connectionId: string, sessionId: string): boolean {
		const connection = this.connections.get(connectionId)
		if (!connection) return false

		connection.subscribe(sessionId)

		let subscribers = this.sessionSubscriptions.get(sessionId)
		if (!subscribers) {
			subscribers = new Set()
			this.sessionSubscriptions.set(sessionId, subscribers)
		}
		subscribers.add(connectionId)

		return true
	}

	/**
	 * Unsubscribe a connection from a session.
	 */
	unsubscribe(connectionId: string, sessionId: string): boolean {
		const connection = this.connections.get(connectionId)
		if (!connection) return false

		connection.unsubscribe(sessionId)
		this.unsubscribeInternal(connectionId, sessionId)

		return true
	}

	/**
	 * Get all subscribers for a session.
	 */
	getSubscribers(sessionId: string): ServerConnection<TReceive, TSend>[] {
		const subscriberIds = this.sessionSubscriptions.get(sessionId)
		if (!subscriberIds) return []

		const subscribers: ServerConnection<TReceive, TSend>[] = []
		const deadIds: string[] = []
		for (const connectionId of subscriberIds) {
			const connection = this.connections.get(connectionId)
			if (connection?.isConnected()) {
				subscribers.push(connection)
			} else {
				deadIds.push(connectionId)
			}
		}

		// Clean up dead subscriptions
		for (const id of deadIds) {
			subscriberIds.delete(id)
		}
		if (subscriberIds.size === 0) {
			this.sessionSubscriptions.delete(sessionId)
		}

		return subscribers
	}

	/**
	 * Get subscriber count for a session.
	 */
	getSubscriberCount(sessionId: string): number {
		return this.sessionSubscriptions.get(sessionId)?.size ?? 0
	}

	/**
	 * Check if a session has any subscribers.
	 */
	hasSubscribers(sessionId: string): boolean {
		return this.getSubscriberCount(sessionId) > 0
	}

	// ============================================================================
	// Broadcasting
	// ============================================================================

	/**
	 * Broadcast a raw message to all subscribers of a session.
	 */
	broadcast(sessionId: string, message: string): number {
		const subscribers = this.getSubscribers(sessionId)
		let sent = 0

		for (const connection of subscribers) {
			if (connection.send(message)) {
				sent++
			}
		}

		return sent
	}

	/**
	 * Broadcast to all connections.
	 */
	broadcastToAll(message: string): number {
		let sent = 0

		for (const connection of this.connections.values()) {
			if (connection.isConnected() && connection.send(message)) {
				sent++
			}
		}

		return sent
	}

	// ============================================================================
	// Statistics
	// ============================================================================

	/**
	 * Get connection statistics.
	 */
	getStats(): ConnectionStats {
		const byClientType: Record<string, number> = {}
		let activeConnections = 0

		for (const connection of this.connections.values()) {
			const clientType = connection.getClientType()
			byClientType[clientType] = (byClientType[clientType] ?? 0) + 1

			if (connection.isConnected()) {
				activeConnections++
			}
		}

		return {
			totalConnections: this.connections.size,
			activeConnections,
			activeSessions: this.sessionSubscriptions.size,
			byClientType,
		}
	}

	// ============================================================================
	// Cleanup
	// ============================================================================

	/**
	 * Clear all connections.
	 */
	clear(): void {
		for (const connection of this.connections.values()) {
			connection.disconnect()
		}
		this.connections.clear()
		this.sessionSubscriptions.clear()
	}

	/**
	 * Remove disconnected connections.
	 */
	cleanup(): number {
		let removed = 0

		for (const [connectionId, connection] of this.connections) {
			if (!connection.isConnected()) {
				this.remove(connectionId)
				removed++
			}
		}

		return removed
	}

	// ============================================================================
	// Private Methods
	// ============================================================================

	/**
	 * Internal unsubscribe (updates subscription map only).
	 */
	private unsubscribeInternal(connectionId: string, sessionId: string): void {
		const subscribers = this.sessionSubscriptions.get(sessionId)
		if (subscribers) {
			subscribers.delete(connectionId)
			if (subscribers.size === 0) {
				this.sessionSubscriptions.delete(sessionId)
			}
		}
	}
}
