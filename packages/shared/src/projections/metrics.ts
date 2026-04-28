/**
 * Metrics projection - tracks token usage, costs, and call counts.
 */

import type { ProjectionEvent } from './events.js'
import type { GetMetricsResponse } from './types.js'

export interface ProviderMetricsState {
	llmCalls: number
	totalTokens: number
	promptTokens: number
	completionTokens: number
	totalCost: number
}

export interface MetricsState {
	totalTokens: number
	promptTokens: number
	completionTokens: number
	llmCalls: number
	toolCalls: number
	totalCost: number
	firstEventTimestamp: number | null
	lastEventTimestamp: number | null
	byProvider: Record<string, ProviderMetricsState>
}

export function createMetricsState(): MetricsState {
	return {
		totalTokens: 0,
		promptTokens: 0,
		completionTokens: 0,
		llmCalls: 0,
		toolCalls: 0,
		totalCost: 0,
		firstEventTimestamp: null,
		lastEventTimestamp: null,
		byProvider: {},
	}
}

export function applyEventToMetrics(state: MetricsState, event: ProjectionEvent): MetricsState {
	// Update timestamps
	const firstEventTimestamp = state.firstEventTimestamp ?? event.timestamp
	const lastEventTimestamp = event.timestamp

	switch (event.type) {
		case 'inference_completed': {
			const provider = event.metrics.provider
			const byProvider = provider
				? {
					...state.byProvider,
					[provider]: {
						llmCalls: (state.byProvider[provider]?.llmCalls ?? 0) + 1,
						totalTokens: (state.byProvider[provider]?.totalTokens ?? 0) + event.metrics.totalTokens,
						promptTokens: (state.byProvider[provider]?.promptTokens ?? 0) + event.metrics.promptTokens,
						completionTokens: (state.byProvider[provider]?.completionTokens ?? 0) + event.metrics.completionTokens,
						totalCost: (state.byProvider[provider]?.totalCost ?? 0) + (event.metrics.cost ?? 0),
					},
				}
				: state.byProvider
			return {
				...state,
				llmCalls: state.llmCalls + 1,
				promptTokens: state.promptTokens + event.metrics.promptTokens,
				completionTokens: state.completionTokens + event.metrics.completionTokens,
				totalTokens: state.totalTokens + event.metrics.totalTokens,
				totalCost: state.totalCost + (event.metrics.cost ?? 0),
				firstEventTimestamp,
				lastEventTimestamp,
				byProvider,
			}
		}

		case 'tool_started':
			return {
				...state,
				toolCalls: state.toolCalls + 1,
				firstEventTimestamp,
				lastEventTimestamp,
			}

		default:
			// Only update timestamps for other events
			if (state.firstEventTimestamp !== firstEventTimestamp || state.lastEventTimestamp !== lastEventTimestamp) {
				return { ...state, firstEventTimestamp, lastEventTimestamp }
			}
			return state
	}
}

/**
 * Convert MetricsState to GetMetricsResponse format.
 */
export function metricsStateToResponse(state: MetricsState, agentCount: number): GetMetricsResponse {
	const durationMs = state.firstEventTimestamp && state.lastEventTimestamp
		? state.lastEventTimestamp - state.firstEventTimestamp
		: 0

	return {
		totalTokens: state.totalTokens,
		promptTokens: state.promptTokens,
		completionTokens: state.completionTokens,
		totalCost: state.totalCost > 0 ? state.totalCost : undefined,
		llmCalls: state.llmCalls,
		toolCalls: state.toolCalls,
		agentCount,
		durationMs,
		byProvider: state.byProvider,
	}
}
