/**
 * Context Compact Plugin — compacts conversation history before inference
 *
 * Moves the ContextCompactor logic from Agent into a beforeInference hook.
 * The compactor class remains as the internal implementation.
 */

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

export const contextCompactPlugin = definePlugin('context-compact')
	.pluginConfig<ContextCompactPluginConfig>()
	.agentConfig<ContextCompactAgentConfig>()
	.context(async (ctx, pluginConfig) => {
		const historyOffloader: HistoryOffloader | undefined = pluginConfig.compaction.offloadHistory
			? new FileHistoryOffloader(ctx.environment.sessionDir, ctx.platform.fs)
			: undefined

		return { historyOffloader, sessionConfig: pluginConfig.compaction }
	})
	.hook('beforeInference', async (ctx) => {
		const { historyOffloader, sessionConfig } = ctx.pluginContext
		const agentOverrides = ctx.pluginAgentConfig ?? {}
		const effectiveConfig: CompactionConfig = { ...sessionConfig, ...agentOverrides }

		const compactor = new ContextCompactor(ctx.logger, effectiveConfig, historyOffloader)
		const historyLLMMessages = ctx.agentState.conversationHistory
		const lastActualPromptTokens = ctx.agentState.lastInferenceMetrics?.promptTokens

		const result = await compactor.compactIfNeeded(
			ctx.sessionId,
			ctx.agentId,
			historyLLMMessages,
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
