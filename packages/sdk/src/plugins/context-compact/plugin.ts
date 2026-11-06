/**
 * Context Compact Plugin — compacts conversation history before inference
 *
 * Moves the ContextCompactor logic from Agent into a beforeInference hook.
 * The compactor class remains as the internal implementation.
 */

import type { AgentId } from '~/core/agents/schema.js'
import { contextEvents } from '~/core/context/state.js'
import { llmEvents } from '~/core/llm/state.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { type CompactionConfig, ContextCompactor, createContextCompactedEvent, type HistoryOffloader } from './context-compactor.js'
import { FileHistoryOffloader } from './history-offloader.js'

/**
 * Plugin config — session-level (default) compaction settings.
 * Individual agents may override fields via `contextCompactPlugin.configureAgent({ ... })`.
 */
export interface ContextCompactPluginConfig {
	compaction: CompactionConfig
}

/**
 * Per-agent override. Any field omitted falls back to the session-level config.
 * Used for cases like "orchestrator gets a tighter 50k threshold while subagents
 * keep the default 200k".
 */
export type ContextCompactAgentConfig = Partial<CompactionConfig>

/** What the agent's last compaction achieved, as measured by the provider. */
interface AgentCompactionState {
	/** A compaction ran and no inference has completed since, so the last prompt size predates it. */
	awaitingInference: boolean
	/** Prompt tokens of the first inference after the last compaction. */
	promptTokensAfter?: number
}

export const contextCompactPlugin = definePlugin('context-compact')
	.events([contextEvents, llmEvents])
	.pluginConfig<ContextCompactPluginConfig>()
	.agentConfig<ContextCompactAgentConfig>()
	.state({
		key: 'contextCompaction',
		initial: (): Map<AgentId, AgentCompactionState> => new Map(),
		reduce: (agents, event) => {
			switch (event.type) {
				case 'context_compacted': {
					const next = new Map(agents)
					next.set(event.agentId, { awaitingInference: true })
					return next
				}
				case 'inference_completed': {
					if (!agents.get(event.agentId)?.awaitingInference) return agents
					const next = new Map(agents)
					next.set(event.agentId, { awaitingInference: false, promptTokensAfter: event.metrics.promptTokens })
					return next
				}
				default:
					return agents
			}
		},
	})
	.context(async (ctx, pluginConfig) => {
		const historyOffloader: HistoryOffloader | undefined = pluginConfig.compaction.offloadHistory
			? new FileHistoryOffloader(ctx.environment.sessionDir, ctx.platform.fs)
			: undefined

		return { historyOffloader, sessionConfig: pluginConfig.compaction }
	})
	.hook('beforeInference', async (ctx) => {
		const compaction = ctx.pluginState.get(ctx.agentId)
		// The last prompt size was measured before that compaction (its inference failed or never ran):
		// compacting on it again would summarise the summary and count another compaction for nothing.
		if (compaction?.awaitingInference) return null

		const { historyOffloader, sessionConfig } = ctx.pluginContext
		const agentOverrides = ctx.pluginAgentConfig ?? {}
		const effectiveConfig: CompactionConfig = { ...sessionConfig, ...agentOverrides }
		const lastActualPromptTokens = ctx.agentState.lastInferenceMetrics?.promptTokens
		const promptTokensAfter = compaction?.promptTokensAfter

		// Compaction only shortens the history: a prompt still over the threshold right after it means either large recent
		// messages the next compaction removes, or a system prompt, tools and preamble too large on their own.
		if (promptTokensAfter !== undefined && promptTokensAfter > effectiveConfig.maxTokens && lastActualPromptTokens === promptTokensAfter) {
			ctx.logger.warn('Prompt is still over maxTokens right after a context compaction', {
				sessionId: ctx.sessionId,
				agentId: ctx.agentId,
				maxTokens: effectiveConfig.maxTokens,
				promptTokensAfterCompaction: promptTokensAfter,
			})
		}

		const compactor = new ContextCompactor(ctx.logger, effectiveConfig, historyOffloader)
		const result = await compactor.compactIfNeeded(
			ctx.sessionId,
			ctx.agentId,
			ctx.agentState.conversationHistory,
			ctx.runAuxiliaryInference,
			lastActualPromptTokens,
		)

		if (result.ok && result.value !== null) {
			const compactedEvent = createContextCompactedEvent(
				ctx.sessionId,
				ctx.agentId,
				result.value,
			)
			await ctx.emitEvent(compactedEvent)
		} else if (!result.ok) {
			ctx.logger.warn('Context compaction failed, continuing with full history', {
				sessionId: ctx.sessionId,
				agentId: ctx.agentId,
				error: result.error.message,
			})
		}

		return null
	})
	.build()
