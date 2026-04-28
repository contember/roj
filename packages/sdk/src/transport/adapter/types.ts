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
