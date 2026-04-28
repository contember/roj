import { MailboxMessage } from '../../plugins/mailbox/schema'
import { PendingToolResult } from '../tools/schema'

/**
 * Context provided to debounce callback for decision making.
 */
export interface DebounceContext {
	/** Unconsumed messages waiting in the mailbox */
	messages: MailboxMessage[]
	/** How long the oldest message has been waiting (ms) */
	oldestWaitingMs: number
	/** Total number of pending messages */
	totalPending: number
	/** Pending tool results awaiting LLM processing */
	pendingToolResults: PendingToolResult[]
}

/**
 * Decision returned by debounce callback.
 */
export type DebounceDecision = 'process_now' | 'wait'

/**
 * Callback function for dynamic debounce decisions.
 * Called periodically to decide whether to process agent mailbox.
 * Async to allow for external checks (e.g., rate limiting, external state).
 */
export type DebounceCallback = (context: DebounceContext) => DebounceDecision | Promise<DebounceDecision>

// ============================================================================
// Preset Debounce Callbacks
// ============================================================================

/**
 * Default debounce callback - process after 500ms wait.
 */
export const defaultDebounceCallback: DebounceCallback = (context) => {
	if (context.oldestWaitingMs > 500) {
		return 'process_now'
	}
	return 'wait'
}

/**
 * Aggressive debounce callback - process quickly after 100ms.
 */
export const aggressiveDebounceCallback: DebounceCallback = (context) => {
	if (context.oldestWaitingMs > 100) {
		return 'process_now'
	}
	return 'wait'
}

/**
 * Batching debounce callback - wait for multiple messages or timeout.
 * Processes when 5+ messages accumulated or after 2s wait.
 */
export const batchingDebounceCallback: DebounceCallback = (context) => {
	if (context.totalPending >= 5 || context.oldestWaitingMs > 2000) {
		return 'process_now'
	}
	return 'wait'
}

/**
 * Wait-for-response debounce callback - waits for response after communication tools.
 * Used by child agents that should wait after sending messages instead of
 * immediately calling LLM with a "WAITING" response.
 *
 * Behavior:
 * - If new mailbox messages arrived, process immediately
 * - If ANY tool result has isError=true, process immediately (error recovery)
 * - If ALL pending tool results are from communication tools (send_message, start_*, etc.),
 *   wait up to 60s for a response before processing
 * - If ANY tool result is NOT a communication tool, process immediately
 */
export const waitForResponseDebounceCallback: DebounceCallback = (context) => {
	// If we have new messages, process immediately
	if (context.totalPending > 0) {
		return 'process_now'
	}

	// If we have pending tool results
	if (context.pendingToolResults.length > 0) {
		// If any tool failed, process immediately for error recovery
		if (context.pendingToolResults.some((r) => r.isError)) {
			return 'process_now'
		}

		// Communication tools - wait for response only if ALL are communication tools
		// Note: start_* tools (e.g., start_researcher) are agent spawning tools
		const commTools = ['send_message', 'tell_user', 'ask_user']
		const isCommTool = (name: string) => commTools.includes(name) || name.startsWith('start_')
		const allAreCommunicationTools = context.pendingToolResults.every(
			(r) => isCommTool(r.toolName),
		)

		if (allAreCommunicationTools) {
			// Find oldest tool result timestamp
			const oldestToolMs = Date.now() - Math.min(
				...context.pendingToolResults.map((r) => r.timestamp),
			)

			// Wait up to 60s for response
			if (oldestToolMs < 60000) {
				return 'wait'
			}
		}

		// Timeout exceeded or has non-communication tool - process now
		return 'process_now'
	}

	// No messages or tool results - wait
	return 'wait'
}
