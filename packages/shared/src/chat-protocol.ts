/**
 * Chat protocol types — shared between agent-server and platform SDK.
 *
 * Defines the shape of chat messages and ask_user input types.
 */
import type { ChatMessageId } from './lib/ids.js'

export interface UserChatMessage {
	type: 'user_message'
	messageId: ChatMessageId
	content: string
	timestamp: number
}

export interface AgentChatMessage {
	type: 'agent_message'
	messageId: ChatMessageId
	content: string
	format: 'text' | 'markdown'
	timestamp: number
}

export interface AskUserChatMessage {
	type: 'ask_user'
	questionId: ChatMessageId
	question: string
	inputType: AskUserInputType
	answered: boolean
	answer?: unknown
	timestamp: number
}

export type ChatMessage = UserChatMessage | AgentChatMessage | AskUserChatMessage

export type AskUserOption = {
	value: string
	label: string
	description?: string
}

export type AskUserInputType =
	| { type: 'text'; placeholder?: string; multiline?: boolean }
	| { type: 'single_choice'; options: AskUserOption[] }
	| { type: 'multi_choice'; options: AskUserOption[]; minSelect?: number; maxSelect?: number }
	| { type: 'rating'; min: number; max: number; labels?: { min?: string; max?: string } }
	| { type: 'confirm'; confirmLabel?: string; cancelLabel?: string }
