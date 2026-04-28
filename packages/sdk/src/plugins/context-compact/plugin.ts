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
 * Plugin config — session-level compaction settings.
 */
export interface ContextCompactPluginConfig {
	compaction: CompactionConfig
}

export const contextCompactPlugin = definePlugin('context-compact')
	.pluginConfig<ContextCompactPluginConfig>()
	.context(async (ctx, pluginConfig) => {
		const historyOffloader: HistoryOffloader | undefined = pluginConfig.compaction.offloadHistory
			? new FileHistoryOffloader(ctx.environment.sessionDir, ctx.platform.fs)
			: undefined

		const compactor = new ContextCompactor(
			ctx.llm,
			ctx.logger,
			pluginConfig.compaction,
			historyOffloader,
		)

		return { compactor }
	})
	.hook('beforeInference', async (ctx) => {
		const compactor = ctx.pluginContext.compactor
		const historyLLMMessages = ctx.agentState.conversationHistory

		const result = await compactor.compactIfNeeded(
			ctx.sessionId,
			ctx.agentId,
			historyLLMMessages,
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
