/**
 * @roj-ai/client-react
 *
 * React hooks, stores, and chat components for consuming a roj platform
 * (either the CF-hosted worker or the standalone server).
 */

// Stores
export { configureConnectionUrl, useAutoConnect, useConnectionStore } from './stores/connection-store.js'
export type { ConnectionStatus, RawMessageHandler, WsUrlBuilder } from './stores/connection-store.js'
export { useSessionMessageHandler, useSessionStore } from './stores/session-store.js'
export type { PendingAttachment, PendingQuestion, QuestionSubmitStatus, ServiceInfo } from './stores/session-store.js'

// Main hook
export { useChat } from './useChat.js'
export type { ChatState, ChatTokenSnapshot, ChatTokenSource, UseChatOptions } from './useChat.js'

// Preview URL
export { usePreviewUrl } from './usePreviewUrl.js'
export type { UsePreviewUrlOptions } from './usePreviewUrl.js'

// Session state hooks
export { useSessionState, useSessionStateValue, useUpdateSessionState } from './useSessionState.js'

// Chat components
export {
	AgentMessage,
	AskUserMessage,
	Confirm,
	MessageInput,
	MessageList,
	MultiChoice,
	QuestionItem,
	QuestionnairePanel,
	QuestionnaireSummary,
	Rating,
	SingleChoice,
	TextInput,
	UserMessage,
} from './components/chat/index.js'
