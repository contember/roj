/**
 * Agent Transport Types
 *
 * Simplified for broadcast-only WebSocket communication.
 * User messages and answers are handled via REST API.
 */

import type { PluginNotification } from '~/core/plugins/plugin-builder.js'

export type { PluginNotification }

// ============================================================================
// Transport Interface (broadcast only)
// ============================================================================

/**
 * What became of one broadcast.
 *
 * `delivered + buffered + dropped === peers`. A notification is ephemeral — it is
 * never persisted and never retried — so `broadcast` still cannot fail. What it
 * can do is say so: `dropped > 0` is a notification the transport threw away.
 */
export interface NotificationDelivery {
	/** Wire bytes of the frame, whether or not anything took it. */
	bytes: number
	/** Connections the notification was routed to (subscribers, or the single upstream link). */
	peers: number
	/** Peers whose socket took the frame. */
	delivered: number
	/** Peers that parked it in their send buffer — delivered only if that socket opens again. */
	buffered: number
	/** Peers that discarded it because their buffer was full. Data loss. */
	dropped: number
}

/** A broadcast that never reached a socket — no peer, or no routable payload. */
export const undelivered = (bytes: number): NotificationDelivery => ({ bytes, peers: 0, delivered: 0, buffered: 0, dropped: 0 })

export interface IAgentTransport {
	start(): Promise<void>
	stop(): Promise<void>
	/**
	 * Fan a plugin notification out. Never throws and never awaits the socket —
	 * it is called from hook and reducer paths that must not block on the network.
	 * The return value is the only channel it has to report loss; hosts that do not
	 * read it still get a warning in the log.
	 */
	broadcast(notification: PluginNotification): NotificationDelivery
}
