/**
 * Result Eviction Plugin - saves large tool outputs to disk
 *
 * When a tool produces output exceeding the token threshold, the full output is saved
 * to a file in the session's .results directory, and a truncated preview with
 * head + tail + file path is returned instead.
 */

import { truncateByTokens } from '~/core/llm/tokens.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'

export interface EvictionConfig {
	/** Max tokens before eviction (default: 20000) */
	maxTokens?: number
}

export interface EvictionAgentConfig {
	/** Whether result eviction is enabled for this agent (default: true) */
	enabled?: boolean
	/** Eviction configuration */
	config?: EvictionConfig
}

const DEFAULT_MAX_TOKENS = 20_000

export const resultEvictionPlugin = definePlugin('result-eviction')
	.agentConfig<EvictionAgentConfig>()
	.hook('afterToolCall', async (ctx) => {
		const agentConfig = ctx.pluginAgentConfig
		const enabled = agentConfig?.enabled !== false

		if (!enabled || ctx.result.isError) {
			return null
		}

		const { content } = ctx.result

		// Only evict string content
		if (typeof content !== 'string') {
			return null
		}

		const maxTokens = agentConfig?.config?.maxTokens ?? DEFAULT_MAX_TOKENS

		const truncation = truncateByTokens(content, maxTokens)
		if (!truncation) {
			return null
		}

		// Write full content to file via FileStore
		const fileName = `${ctx.toolCall.id}.txt`
		const filePath = `.results/${fileName}`
		await ctx.files.session.write(filePath, content)

		const truncatedContent = `${truncation.content}\n\n[Full output saved to: ${filePath}]`

		return {
			action: 'modify',
			result: {
				isError: false,
				content: truncatedContent,
			},
		}
	})
	.build()
