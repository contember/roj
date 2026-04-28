/**
 * Chat debug projection - tracks user-visible chat messages with debug links.
 */

import type { AgentId, LLMCallId, ToolCallId } from '@roj-ai/sdk'
import type { AgentRegistryState } from './agent-registry.js'
import type { ProjectionEvent } from './events.js'
import type { DebugChatMessage } from './types.js'

/**
 * State for tracking chat messages with debug info.
 */
export interface ChatDebugState {
	messages: DebugChatMessage[]
	/** Tracking pending tool calls for linking (toolCallId -> { agentId, llmCallId, toolName }) */
	pendingToolCalls: Map<ToolCallId, { agentId: AgentId; llmCallId?: LLMCallId; toolName: string }>
	/** Last LLM call ID by agent (for linking tool calls to inference) */
	lastLLMCallByAgent: Map<AgentId, LLMCallId>
	/** Event index counter */
	eventIndex: number
}

export function createChatDebugState(): ChatDebugState {
	return {
		messages: [],
		pendingToolCalls: new Map(),
		lastLLMCallByAgent: new Map(),
		eventIndex: 0,
	}
}

/**
 * Apply event to chat debug state.
 * @param registry Agent registry for name lookups
 */
export function applyEventToChatDebug(
	state: ChatDebugState,
	event: ProjectionEvent,
	registry: AgentRegistryState,
): ChatDebugState {
	const currentIndex = state.eventIndex
	const nextIndex = currentIndex + 1

	const getAgentName = (agentId: AgentId): string => {
		return registry.names.get(agentId) ?? 'unknown'
	}

	switch (event.type) {
		case 'inference_completed': {
			// Track the last LLM call for this agent
			if (event.llmCallId) {
				const newLastLLMCallByAgent = new Map(state.lastLLMCallByAgent)
				newLastLLMCallByAgent.set(event.agentId, event.llmCallId)
				return {
					...state,
					lastLLMCallByAgent: newLastLLMCallByAgent,
					eventIndex: nextIndex,
				}
			}
			return { ...state, eventIndex: nextIndex }
		}

		case 'tool_started': {
			// Only track send_user_message and ask_user tools
			if (event.toolName === 'send_user_message' || event.toolName === 'ask_user') {
				const llmCallId = state.lastLLMCallByAgent.get(event.agentId)
				const newPendingToolCalls = new Map(state.pendingToolCalls)
				newPendingToolCalls.set(event.toolCallId, {
					agentId: event.agentId,
					llmCallId,
					toolName: event.toolName,
				})
				return {
					...state,
					pendingToolCalls: newPendingToolCalls,
					eventIndex: nextIndex,
				}
			}
			return { ...state, eventIndex: nextIndex }
		}

		case 'user_message_sent': {
			// Find the pending tool call for this message
			let toolCallId: ToolCallId | undefined
			let llmCallId: LLMCallId | undefined
			let agentId: AgentId | undefined

			// Look through pending tool calls to find a send_user_message from the same agent
			for (const [tcId, info] of state.pendingToolCalls) {
				if (info.toolName === 'send_user_message' && info.agentId === event.agentId) {
					toolCallId = tcId
					llmCallId = info.llmCallId
					agentId = info.agentId
					break
				}
			}

			// Clean up the used pending tool call
			const newPendingToolCalls = new Map(state.pendingToolCalls)
			if (toolCallId) {
				newPendingToolCalls.delete(toolCallId)
			}

			const newMessage: DebugChatMessage = {
				type: 'agent_message',
				messageId: event.messageId,
				content: event.message,
				timestamp: event.timestamp,
				eventIndex: currentIndex,
				agentId: agentId ?? event.agentId,
				agentName: getAgentName(agentId ?? event.agentId),
				llmCallId,
				toolCallId,
				format: event.format,
			}

			return {
				...state,
				messages: [...state.messages, newMessage],
				pendingToolCalls: newPendingToolCalls,
				eventIndex: nextIndex,
			}
		}

		case 'user_question_asked': {
			// Find the pending tool call for this question
			let toolCallId: ToolCallId | undefined
			let llmCallId: LLMCallId | undefined
			let agentId: AgentId | undefined

			// Look through pending tool calls to find an ask_user from the same agent
			for (const [tcId, info] of state.pendingToolCalls) {
				if (info.toolName === 'ask_user' && info.agentId === event.agentId) {
					toolCallId = tcId
					llmCallId = info.llmCallId
					agentId = info.agentId
					break
				}
			}

			// Clean up the used pending tool call
			const newPendingToolCalls = new Map(state.pendingToolCalls)
			if (toolCallId) {
				newPendingToolCalls.delete(toolCallId)
			}

			const newMessage: DebugChatMessage = {
				type: 'ask_user',
				messageId: event.messageId,
				content: event.question,
				timestamp: event.timestamp,
				eventIndex: currentIndex,
				agentId: agentId ?? event.agentId,
				agentName: getAgentName(agentId ?? event.agentId),
				llmCallId,
				toolCallId,
				inputType: event.inputType,
				answered: false,
			}

			return {
				...state,
				messages: [...state.messages, newMessage],
				pendingToolCalls: newPendingToolCalls,
				eventIndex: nextIndex,
			}
		}

		case 'user_chat_message_received': {
			const newMessage: DebugChatMessage = {
				type: 'user_message',
				messageId: event.messageId,
				content: event.content,
				timestamp: event.timestamp,
				eventIndex: currentIndex,
				agentId: event.agentId,
				agentName: getAgentName(event.agentId),
			}

			return {
				...state,
				messages: [...state.messages, newMessage],
				eventIndex: nextIndex,
			}
		}

		case 'user_chat_answer_received': {
			const updatedMessages = state.messages.map((msg) => {
				if (msg.type === 'ask_user' && msg.messageId === event.questionId) {
					return {
						...msg,
						answered: true,
						answer: event.answerValue,
					}
				}
				return msg
			})

			return {
				...state,
				messages: updatedMessages,
				eventIndex: nextIndex,
			}
		}

		case 'mailbox_message': {
			// Only handle user messages (not answers to questions)
			if (event.message.from === 'user' && !event.message.answerTo) {
				const newMessage: DebugChatMessage = {
					type: 'user_message',
					messageId: event.message.id,
					content: event.message.content,
					timestamp: event.message.timestamp,
					eventIndex: currentIndex,
					agentId: event.toAgentId,
					agentName: getAgentName(event.toAgentId),
					mailboxMessageId: event.message.id,
				}

				return {
					...state,
					messages: [...state.messages, newMessage],
					eventIndex: nextIndex,
				}
			}

			// Handle answer to question - update the ask_user message
			if (event.message.from === 'user' && event.message.answerTo) {
				const updatedMessages = state.messages.map((msg) => {
					if (msg.type === 'ask_user' && msg.messageId === event.message.answerTo) {
						return {
							...msg,
							answered: true,
							answer: event.message.answerValue,
						}
					}
					return msg
				})

				return {
					...state,
					messages: updatedMessages,
					eventIndex: nextIndex,
				}
			}

			return { ...state, eventIndex: nextIndex }
		}

		default:
			return { ...state, eventIndex: nextIndex }
	}
}

/**
 * Get chat debug messages sorted by timestamp.
 */
export function getChatDebugMessages(state: ChatDebugState): DebugChatMessage[] {
	return state.messages
}
