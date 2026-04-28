/**
 * Timeline projection - tracks LLM calls, tool executions, and compactions.
 */

import type { AgentId, InferenceStartedEvent, LLMCallLogEntry, ToolCallId, ToolStartedEvent } from '@roj-ai/sdk'
import type { AgentRegistryState } from './agent-registry.js'
import type { ProjectionEvent } from './events.js'
import type { TimelineItem } from './types.js'

export interface TimelineState {
	items: TimelineItem[]
	/** Pending inference starts waiting for completion */
	pendingInferences: Map<string, InferenceStartedEvent>
	/** Pending tool starts waiting for completion */
	pendingTools: Map<string, ToolStartedEvent>
}

export function createTimelineState(): TimelineState {
	return {
		items: [],
		pendingInferences: new Map(),
		pendingTools: new Map(),
	}
}

/**
 * Apply event to timeline state.
 * @param registry Agent registry for name lookups
 * @param llmCallMap Optional map for enriching LLM calls with detailed metrics
 */
export function applyEventToTimeline(
	state: TimelineState,
	event: ProjectionEvent,
	registry: AgentRegistryState,
	llmCallMap?: Map<string, LLMCallLogEntry>,
): TimelineState {
	const getAgentName = (agentId: string): string => {
		return registry.names.get(agentId as AgentId) ?? 'unknown'
	}

	switch (event.type) {
		case 'inference_started': {
			const newPending = new Map(state.pendingInferences)
			newPending.set(event.agentId, event)
			return { ...state, pendingInferences: newPending }
		}

		case 'inference_completed': {
			const startEvent = state.pendingInferences.get(event.agentId)
			const newPending = new Map(state.pendingInferences)
			newPending.delete(event.agentId)

			const llmCall = event.llmCallId && llmCallMap ? llmCallMap.get(event.llmCallId) : undefined
			const metrics = llmCall?.metrics ?? event.metrics

			const newItem: TimelineItem = {
				id: event.llmCallId ?? `llm-${event.agentId}-${event.timestamp}`,
				type: 'llm',
				agentId: event.agentId,
				agentName: getAgentName(event.agentId),
				startedAt: startEvent?.timestamp ?? event.timestamp,
				completedAt: event.timestamp,
				durationMs: startEvent ? event.timestamp - startEvent.timestamp : undefined,
				status: 'success',
				model: event.metrics.model,
				promptTokens: metrics.promptTokens,
				completionTokens: metrics.completionTokens,
				cachedTokens: metrics.cachedTokens,
				cacheWriteTokens: metrics.cacheWriteTokens,
				cost: metrics.cost,
				llmCallId: event.llmCallId,
			}

			return {
				...state,
				items: [...state.items, newItem],
				pendingInferences: newPending,
			}
		}

		case 'inference_failed': {
			const startEvent = state.pendingInferences.get(event.agentId)
			const newPending = new Map(state.pendingInferences)
			newPending.delete(event.agentId)

			const newItem: TimelineItem = {
				id: event.llmCallId ?? `llm-${event.agentId}-${event.timestamp}`,
				type: 'llm',
				agentId: event.agentId,
				agentName: getAgentName(event.agentId),
				startedAt: startEvent?.timestamp ?? event.timestamp,
				completedAt: event.timestamp,
				durationMs: startEvent ? event.timestamp - startEvent.timestamp : undefined,
				status: 'error',
				error: event.error,
				llmCallId: event.llmCallId,
			}

			return {
				...state,
				items: [...state.items, newItem],
				pendingInferences: newPending,
			}
		}

		case 'tool_started': {
			const newPending = new Map(state.pendingTools)
			newPending.set(event.toolCallId, event)
			return { ...state, pendingTools: newPending }
		}

		case 'tool_completed': {
			const startEvent = state.pendingTools.get(event.toolCallId)
			const newPending = new Map(state.pendingTools)
			newPending.delete(event.toolCallId)

			const newItem: TimelineItem = {
				id: event.toolCallId,
				type: 'tool',
				agentId: event.agentId,
				agentName: getAgentName(event.agentId),
				startedAt: startEvent?.timestamp ?? event.timestamp,
				completedAt: event.timestamp,
				durationMs: startEvent ? event.timestamp - startEvent.timestamp : undefined,
				status: 'success',
				toolName: startEvent?.toolName,
				toolCallId: event.toolCallId,
				toolInput: startEvent?.input,
				toolResult: event.result,
			}

			return {
				...state,
				items: [...state.items, newItem],
				pendingTools: newPending,
			}
		}

		case 'tool_failed': {
			const startEvent = state.pendingTools.get(event.toolCallId)
			const newPending = new Map(state.pendingTools)
			newPending.delete(event.toolCallId)

			const newItem: TimelineItem = {
				id: event.toolCallId,
				type: 'tool',
				agentId: event.agentId,
				agentName: getAgentName(event.agentId),
				startedAt: startEvent?.timestamp ?? event.timestamp,
				completedAt: event.timestamp,
				durationMs: startEvent ? event.timestamp - startEvent.timestamp : undefined,
				status: 'error',
				toolName: startEvent?.toolName,
				toolCallId: event.toolCallId,
				toolInput: startEvent?.input,
				error: event.error,
			}

			return {
				...state,
				items: [...state.items, newItem],
				pendingTools: newPending,
			}
		}

		case 'context_compacted': {
			const newItem: TimelineItem = {
				id: `compaction-${event.agentId}-${event.timestamp}`,
				type: 'compaction',
				agentId: event.agentId,
				agentName: getAgentName(event.agentId),
				startedAt: event.timestamp,
				completedAt: event.timestamp,
				status: 'success',
				originalTokens: event.originalTokens,
				compactedTokens: event.compactedTokens,
				messagesRemoved: event.messagesRemoved,
			}

			return {
				...state,
				items: [...state.items, newItem],
			}
		}

		default:
			return state
	}
}

/**
 * Get timeline items including running items from pending state.
 */
export function getTimelineItems(state: TimelineState, registry: AgentRegistryState): TimelineItem[] {
	const items = [...state.items]

	// Add running items for pending inferences
	for (const [agentId, startEvent] of state.pendingInferences) {
		items.push({
			id: `llm-running-${agentId}-${startEvent.timestamp}`,
			type: 'llm',
			agentId: agentId as AgentId,
			agentName: registry.names.get(agentId as AgentId) ?? 'unknown',
			startedAt: startEvent.timestamp,
			status: 'running',
		})
	}

	// Add running items for pending tools
	for (const [toolCallId, startEvent] of state.pendingTools) {
		items.push({
			id: toolCallId,
			type: 'tool',
			agentId: startEvent.agentId,
			agentName: registry.names.get(startEvent.agentId) ?? 'unknown',
			startedAt: startEvent.timestamp,
			status: 'running',
			toolName: startEvent.toolName,
			toolCallId: toolCallId as ToolCallId,
			toolInput: startEvent.input,
		})
	}

	// Sort by startedAt
	items.sort((a, b) => a.startedAt - b.startedAt)

	return items
}
