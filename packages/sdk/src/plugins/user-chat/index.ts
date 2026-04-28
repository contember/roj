// Plugin
export { userChatPlugin, userChatPlugin as userCommunicationPlugin } from './plugin.js'
export type {
	UserChatAgentConfig as UserCommunicationAgentConfig,
	UserChatPresetConfig as UserCommunicationPresetConfig,
	UserCommunicationMode,
} from './plugin.js'

// Schema
export type { AskUserInputType, AskUserOption } from './schema.js'

// Events (now in plugin.ts)
export { userChatEvents, userChatEvents as userCommunicationEvents } from './plugin.js'
export type { UserMessageSentEvent, UserQuestionAskedEvent } from './plugin.js'

// State types
export type { AgentChatMessage, AskUserChatMessage, ChatMessage, PendingInboundMessage, UserChatMessage } from './plugin.js'
