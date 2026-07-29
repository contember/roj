import type { LLMMessage, ToolLLMMessage, UserLLMMessage } from '~/core/agents/state.js'
import type { ChatMessageContentItem } from '~/core/llm/llm-log-types.js'
import type { Logger } from '~/lib/logger/logger.js'

export class ProviderMessageValidationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ProviderMessageValidationError'
	}
}

const convertOrphanedToolResult = (message: ToolLLMMessage): UserLLMMessage => {
	const toolName = message.toolName ? ` from "${message.toolName}"` : ''
	const errorMarker = message.isError ? ' (error)' : ''
	const marker = `[Orphaned tool result${toolName}; tool call ID: ${message.toolCallId}${errorMarker}]`
	const markerItem: ChatMessageContentItem = { type: 'text', text: marker }
	const content = typeof message.content === 'string'
		? `${marker}\n${message.content}`
		: [markerItem, ...message.content]

	return {
		role: 'user',
		content,
		cacheControl: message.cacheControl,
	}
}

/**
 * Preserve orphaned tool results as user messages and reject assistant-prefill requests.
 */
export const sanitizeProviderMessages = (
	messages: LLMMessage[],
	provider: string,
	logger?: Logger,
): LLMMessage[] => {
	const declaredToolCallIds = new Set<string>()
	let sanitizedMessages: LLMMessage[] | undefined

	for (const [messageIndex, message] of messages.entries()) {
		if (message.role === 'assistant') {
			for (const toolCall of message.toolCalls ?? []) {
				declaredToolCallIds.add(toolCall.id)
			}
		}

		if (message.role === 'tool' && !declaredToolCallIds.has(message.toolCallId)) {
			sanitizedMessages ??= messages.slice(0, messageIndex)
			sanitizedMessages.push(convertOrphanedToolResult(message))
			logger?.warn('Orphaned tool result converted to user message', {
				provider,
				messageIndex,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
			})
			continue
		}

		sanitizedMessages?.push(message)
	}

	const result = sanitizedMessages ?? messages
	const lastMessage = result[result.length - 1]
	if (lastMessage?.role === 'assistant') {
		throw new ProviderMessageValidationError(
			`${provider} request history ends with an assistant message after sanitation`,
		)
	}

	return result
}
