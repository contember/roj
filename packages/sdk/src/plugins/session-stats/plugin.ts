import { agentEvents } from '~/core/agents/state.js'
import { llmEvents } from '~/core/llm/state.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import type { SessionState } from '~/core/sessions/state.js'
import { toolEvents } from '~/core/tools/state.js'

// ============================================================================
// Session stats state
// ============================================================================

export interface ProviderStats {
	llmCalls: number
	totalTokens: number
	promptTokens: number
	completionTokens: number
	totalCost: number
}

export interface SessionStatsState {
	totalTokens: number
	promptTokens: number
	completionTokens: number
	totalCost: number
	llmCalls: number
	llmErrors: number
	toolCalls: number
	toolErrors: number
	agentCount: number
	firstEventAt: number | null
	lastEventAt: number | null
	/** Per-provider breakdown of LLM usage */
	byProvider: Record<string, ProviderStats>
}

const createInitialStats = (): SessionStatsState => ({
	totalTokens: 0,
	promptTokens: 0,
	completionTokens: 0,
	totalCost: 0,
	llmCalls: 0,
	llmErrors: 0,
	toolCalls: 0,
	toolErrors: 0,
	agentCount: 0,
	firstEventAt: null,
	lastEventAt: null,
	byProvider: {},
})

const PLUGIN_STATE_KEY = 'sessionStats'

/**
 * Select session stats from session state (for external consumers).
 */
export function selectSessionStats(sessionState: SessionState): SessionStatsState {
	return selectPluginState<SessionStatsState>(sessionState, PLUGIN_STATE_KEY) ?? createInitialStats()
}

// ============================================================================
// Plugin
// ============================================================================

export const sessionStatsPlugin = definePlugin('session-stats')
	.events([agentEvents, llmEvents, toolEvents])
	.state({
		key: PLUGIN_STATE_KEY,
		initial: createInitialStats,
		reduce: (stats, event) => {
			const now = event.timestamp
			const withTimestamp = (partial: Partial<SessionStatsState>): SessionStatsState => ({
				...stats,
				...partial,
				firstEventAt: stats.firstEventAt ?? now,
				lastEventAt: now,
			})

			switch (event.type) {
				case 'agent_spawned':
					return withTimestamp({ agentCount: stats.agentCount + 1 })

				case 'inference_completed': {
					const provider = event.metrics.provider
					const byProvider = provider
						? {
							...stats.byProvider,
							[provider]: {
								llmCalls: (stats.byProvider[provider]?.llmCalls ?? 0) + 1,
								totalTokens: (stats.byProvider[provider]?.totalTokens ?? 0) + event.metrics.totalTokens,
								promptTokens: (stats.byProvider[provider]?.promptTokens ?? 0) + event.metrics.promptTokens,
								completionTokens: (stats.byProvider[provider]?.completionTokens ?? 0) + event.metrics.completionTokens,
								totalCost: (stats.byProvider[provider]?.totalCost ?? 0) + (event.metrics.cost ?? 0),
							},
						}
						: stats.byProvider
					return withTimestamp({
						llmCalls: stats.llmCalls + 1,
						totalTokens: stats.totalTokens + event.metrics.totalTokens,
						promptTokens: stats.promptTokens + event.metrics.promptTokens,
						completionTokens: stats.completionTokens + event.metrics.completionTokens,
						totalCost: stats.totalCost + (event.metrics.cost ?? 0),
						byProvider,
					})
				}

				case 'inference_failed':
					return withTimestamp({ llmErrors: stats.llmErrors + 1 })

				case 'tool_started':
					return withTimestamp({ toolCalls: stats.toolCalls + 1 })

				case 'tool_failed':
					return withTimestamp({ toolErrors: stats.toolErrors + 1 })

				default:
					return stats
			}
		},
	})
	.build()
