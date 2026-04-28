/**
 * @roj-ai/client-react
 *
 * React hooks, stores, and chat components for consuming a roj platform
 * (either the CF-hosted worker or the standalone server).
 */

// Stores
export { configureConnectionUrl, useAutoConnect, useConnectionStore } from './stores/connection-store'
export type { ConnectionStatus, RawMessageHandler, WsUrlBuilder } from './stores/connection-store'
export { useSessionMessageHandler, useSessionStore } from './stores/session-store'
export type { PendingAttachment, PendingQuestion, QuestionSubmitStatus, ServiceInfo } from './stores/session-store'

// Main hook
export { useChat } from './useChat'
export type { ChatState, UseChatOptions } from './useChat'

// Preview URL
export { usePreviewUrl } from './usePreviewUrl'
export type { UsePreviewUrlOptions } from './usePreviewUrl'

// Session state hooks
export { useSessionState, useSessionStateValue, useUpdateSessionState } from './useSessionState'

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
} from './components/chat'
