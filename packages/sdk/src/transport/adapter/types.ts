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

export interface IAgentTransport {
	start(): Promise<void>
	stop(): Promise<void>
	broadcast(notification: PluginNotification): void
}

// ============================================================================
// Liveness probe
// ============================================================================

/** Wire type of the client's liveness probe. */
export const HEARTBEAT_TYPE = 'heartbeat'

/** Wire type of the host's answer to a probe — its absence is what marks a link dead. */
export const HEARTBEAT_ACK_TYPE = 'heartbeat_ack'
