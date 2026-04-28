/**
 * Core Transport Types
 *
 * Platform-agnostic types for WebSocket transport infrastructure.
 */

// ============================================================================
// Connection States
// ============================================================================

/**
 * Connection state machine states.
 */
export type ConnectionState =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'reconnecting'

// ============================================================================
// Wire Message Format
// ============================================================================

/**
 * Wire message envelope for all protocol messages.
 * Simplified: notification-only, no correlation ID.
 */
export interface WireMessage<T = unknown> {
	/** Notification type name */
	type: string
	/** Message payload */
	payload: T
	/** Timestamp */
	ts: number
}

// ============================================================================
// Transport Events
// ============================================================================

/**
 * Transport event types.
 */
export type TransportEvent =
	| 'connected'
	| 'disconnected'
	| 'error'
	| 'reconnecting'
	| 'reconnected'
	| 'state_change'
	| 'router_error'

/**
 * Transport event listener.
 */
export type TransportEventListener = (event: TransportEvent, data?: unknown) => void

// ============================================================================
// Configuration
// ============================================================================

/**
 * Reconnection strategy options.
 */
export interface ReconnectOptions {
	/** Base delay in ms (default: 1000) */
	baseDelayMs: number
	/** Maximum delay in ms (default: 30000) */
	maxDelayMs: number
	/** Maximum number of attempts before giving up (default: Infinity) */
	maxAttempts: number
	/** Jitter factor (0-1, default: 0.3) */
	jitterFactor: number
}

// ============================================================================
// Default Values
// ============================================================================

export const DEFAULT_RECONNECT_OPTIONS: ReconnectOptions = {
	baseDelayMs: 1000,
	maxDelayMs: 30000,
	maxAttempts: Infinity,
	jitterFactor: 0.3,
}
