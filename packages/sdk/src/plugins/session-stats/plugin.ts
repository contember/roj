import { agentEvents } from '~/core/agents/state.js'
import { contextEvents } from '~/core/context/state.js'
import { llmEvents } from '~/core/llm/state.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import type { SessionState } from '~/core/sessions/state.js'
import { toolEvents } from '~/core/tools/state.js'
import { userChatEvents } from '~/plugins/user-chat/plugin.js'

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

export interface AgentStats {
	llmCalls: number
	promptTokens: number
	completionTokens: number
	totalCost: number
}

export interface SessionStatsState {
	totalTokens: number
	promptTokens: number
	completionTokens: number
	/** Prompt tokens served from the provider cache (a subset of promptTokens) */
	cacheReadTokens: number
	/** Prompt tokens written to the provider cache */
	cacheWriteTokens: number
	totalCost: number
	llmCalls: number
	llmErrors: number
	toolCalls: number
	toolErrors: number
	/** Chat messages received from the user */
	userMessages: number
	/** Context compactions performed in this session */
	compactions: number
	agentCount: number
	firstEventAt: number | null
	lastEventAt: number | null
	/** Per-provider breakdown of LLM usage */
	byProvider: Record<string, ProviderStats>
	/** Per agent-definition breakdown of LLM usage (keyed by definition name, not agent id) */
	byAgent: Record<string, AgentStats>
}

const createInitialStats = (): SessionStatsState => ({
	totalTokens: 0,
	promptTokens: 0,
	completionTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalCost: 0,
	llmCalls: 0,
	llmErrors: 0,
	toolCalls: 0,
	toolErrors: 0,
	userMessages: 0,
	compactions: 0,
	agentCount: 0,
	firstEventAt: null,
	lastEventAt: null,
	byProvider: {},
	byAgent: {},
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
	.order(130)
	.events([agentEvents, llmEvents, toolEvents, contextEvents, userChatEvents])
	.state({
		key: PLUGIN_STATE_KEY,
		initial: createInitialStats,
		reduce: (stats, event, sessionState) => {
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

				// inference_completed = main agent turns; auxiliary_inference_completed =
				// side-channel calls (e.g. context compaction). Both are billed LLM
				// calls, so both feed the same usage/cost accounting.
				case 'inference_completed':
				case 'auxiliary_inference_completed': {
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
					// Core reducer runs before plugin slices, so the spawning agent is already in state.
					const definitionName = sessionState.agents.get(event.agentId)?.definitionName
					const byAgent = definitionName
						? {
							...stats.byAgent,
							[definitionName]: {
								llmCalls: (stats.byAgent[definitionName]?.llmCalls ?? 0) + 1,
								promptTokens: (stats.byAgent[definitionName]?.promptTokens ?? 0) + event.metrics.promptTokens,
								completionTokens: (stats.byAgent[definitionName]?.completionTokens ?? 0) + event.metrics.completionTokens,
								totalCost: (stats.byAgent[definitionName]?.totalCost ?? 0) + (event.metrics.cost ?? 0),
							},
						}
						: stats.byAgent
					return withTimestamp({
						llmCalls: stats.llmCalls + 1,
						totalTokens: stats.totalTokens + event.metrics.totalTokens,
						promptTokens: stats.promptTokens + event.metrics.promptTokens,
						completionTokens: stats.completionTokens + event.metrics.completionTokens,
						cacheReadTokens: stats.cacheReadTokens + (event.metrics.cachedTokens ?? 0),
						cacheWriteTokens: stats.cacheWriteTokens + (event.metrics.cacheWriteTokens ?? 0),
						totalCost: stats.totalCost + (event.metrics.cost ?? 0),
						byProvider,
						byAgent,
					})
				}

				case 'inference_failed':
					return withTimestamp({ llmErrors: stats.llmErrors + 1 })

				case 'tool_started':
					return withTimestamp({ toolCalls: stats.toolCalls + 1 })

				case 'tool_failed':
					return withTimestamp({ toolErrors: stats.toolErrors + 1 })

				case 'user_chat_message_received':
					return withTimestamp({ userMessages: stats.userMessages + 1 })

				case 'context_compacted':
					return withTimestamp({ compactions: stats.compactions + 1 })

				default:
					return stats
			}
		},
	})
	.build()
