/**
 * Result Eviction Plugin - saves large tool outputs to disk
 *
 * When a tool produces output exceeding the token threshold, the full output is saved
 * to a file in the session's .results directory, and a truncated preview with
 * head + tail + file path is returned instead.
 */

import { type ChatMessageContentItem, contentToString, type ToolResultContent } from '~/core/llm/llm-log-types.js'
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

const isImage = (item: ChatMessageContentItem): boolean => item.type === 'image_url'

/**
 * Rebuild a multi-part result with its text collapsed to `preview` and every
 * image part preserved in order.
 *
 * Images are kept rather than truncated because there is no partial image — the
 * alternative to keeping it is dropping the observation entirely. Text is the
 * part that both dominates the payload and survives being summarised.
 */
const withTextReplaced = (content: ChatMessageContentItem[], preview: string): ChatMessageContentItem[] => [
	{ type: 'text', text: preview },
	...content.filter(isImage),
]

export const resultEvictionPlugin = definePlugin('result-eviction')
	.agentConfig<EvictionAgentConfig>()
	.hook('afterToolCall', async (ctx) => {
		const agentConfig = ctx.pluginAgentConfig
		const enabled = agentConfig?.enabled !== false

		if (!enabled || ctx.result.isError) {
			return null
		}

		const { content } = ctx.result
		const maxTokens = agentConfig?.config?.maxTokens ?? DEFAULT_MAX_TOKENS

		// Multi-part results (e.g. a page snapshot returning JSON + a screenshot)
		// used to bail out here, so no threshold could ever evict them however
		// large the text grew. Measure the text, evict the text, keep the images.
		const text = contentToString(content)
		const truncation = truncateByTokens(text, maxTokens)
		if (!truncation) {
			return null
		}

		// Write full text to file via FileStore
		const fileName = `${ctx.toolCall.id}.txt`
		const filePath = `.results/${fileName}`
		await ctx.files.session.write(filePath, text)

		const preview = `${truncation.content}\n\n[Full output saved to: ${filePath}]`
		const evicted: ToolResultContent = typeof content === 'string' ? preview : withTextReplaced(content, preview)

		return {
			action: 'modify',
			result: {
				isError: false,
				content: evicted,
			},
		}
	})
	.build()
