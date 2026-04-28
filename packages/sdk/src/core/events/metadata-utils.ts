/**
 * Utility functions for computing session metadata from events.
 * Used for metadata reconciliation after crashes.
 */

import type { agentEvents } from '~/core/agents/state.js'
import type { DomainEvent, FactoryEventType } from '~/core/events/types.js'
import type { llmEvents } from '~/core/llm/state.js'
import type { SessionId, SessionMetadata, SessionMetadataMetrics } from '~/core/sessions/schema.js'
import type { sessionEvents } from '~/core/sessions/state.js'
import type { toolEvents } from '~/core/tools/state.js'
import type { mailboxEvents } from '~/plugins/mailbox/state.js'

export type MetadataEvent = FactoryEventType<typeof sessionEvents | typeof agentEvents | typeof llmEvents | typeof mailboxEvents | typeof toolEvents>

/**
 * Compute metrics from a list of events.
 * This is the source of truth for what metrics should be.
 */
export function computeMetricsFromEvents(events: DomainEvent[]): SessionMetadataMetrics {
	const metrics: SessionMetadataMetrics = {
		totalEvents: events.length,
		totalAgents: 0,
		totalTokens: 0,
		totalLLMCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalCost: 0,
		totalMessages: 0,
		totalToolCalls: 0,
	}

	for (const event of events as MetadataEvent[]) {
		switch (event.type) {
			case 'agent_spawned':
				metrics.totalAgents++
				break

			case 'inference_completed':
				if (event.metrics) {
					metrics.totalLLMCalls++
					metrics.totalTokens += event.metrics.totalTokens ?? 0
					metrics.inputTokens! += event.metrics.promptTokens ?? 0
					metrics.outputTokens! += event.metrics.completionTokens ?? 0
					if (event.metrics.cost !== undefined) {
						metrics.totalCost! += event.metrics.cost
					}
				}
				break

			case 'mailbox_message':
				metrics.totalMessages!++
				break

			case 'tool_started':
				metrics.totalToolCalls!++
				break
		}
	}

	return metrics
}

/**
 * Compute full metadata from events (for initial creation or full reconciliation).
 */
export function computeMetadataFromEvents(
	sessionId: SessionId,
	events: DomainEvent[],
): SessionMetadata | null {
	if (events.length === 0) return null

	const firstEvent = events[0] as MetadataEvent
	if (firstEvent.type !== 'session_created') {
		return null
	}

	const lastEvent = events[events.length - 1]
	const metrics = computeMetricsFromEvents(events)

	// Determine status from events
	let status: SessionMetadata['status'] = 'active'
	for (const event of events as MetadataEvent[]) {
		if (event.type === 'session_closed') {
			status = 'closed'
		} else if (event.type === 'session_reopened') {
			status = 'active'
		}
		// Check for errored state - if last event is inference_failed, session might be errored
		if (event.type === 'inference_failed') {
			// Only mark as errored if it's the most recent significant event
			// This is a heuristic - actual status should come from session state
		}
	}

	return {
		sessionId,
		presetId: firstEvent.presetId,
		createdAt: firstEvent.timestamp,
		lastActivityAt: lastEvent.timestamp,
		status,
		metrics,
	}
}

/**
 * Check if stored metadata needs reconciliation by comparing key metrics.
 * Returns true if reconciliation is needed.
 */
export function needsReconciliation(
	stored: SessionMetadata | null,
	computed: SessionMetadata,
): boolean {
	if (!stored) return true
	if (!stored.metrics) return true
	if (!computed.metrics) return false

	// Check totalEvents as the primary consistency indicator
	if (stored.metrics.totalEvents !== computed.metrics.totalEvents) {
		return true
	}

	// Check other metrics for consistency
	if (stored.metrics.totalAgents !== computed.metrics.totalAgents) {
		return true
	}

	if (stored.metrics.totalLLMCalls !== computed.metrics.totalLLMCalls) {
		return true
	}

	return false
}
