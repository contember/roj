/**
 * @roj-ai/shared
 *
 * Shared projections and utilities for Roj packages.
 * Pure functions with no runtime dependencies beyond @roj-ai/sdk types.
 */

// ID constructors (branded types — compile-time only)
export { AgentId, ChatMessageId, SessionId } from './lib/ids.js'
export type { AgentId as AgentIdType, ChatMessageId as ChatMessageIdType, SessionId as SessionIdType } from './lib/ids.js'

// Chat protocol types
export type {
	AgentChatMessage,
	AskUserChatMessage,
	AskUserInputType,
	AskUserOption,
	ChatMessage,
	UserChatMessage,
} from './chat-protocol.js'

// Domain utilities
export { contentToString, isDomainEvent } from './lib/domain-utils.js'

// Projections
export {
	applyEventToAgentDetail,
	applyEventToAgentRegistry,
	applyEventToAgentTree,
	applyEventToChatDebug,
	applyEventToMailbox,
	applyEventToMetrics,
	applyEventToServices,
	applyEventToSessionInfo,
	applyEventToTimeline,
	buildAgentTreeFromProjection,
	createAgentDetailProjectionState,
	createAgentRegistryState,
	createAgentTreeProjectionState,
	createChatDebugState,
	createMailboxState,
	createMetricsState,
	createServicesProjectionState,
	createSessionInfoState,
	createTimelineState,
	getAgentDetail,
	getAgentName,
	getChatDebugMessages,
	getMailboxMessages,
	getTimelineItems,
	metricsStateToResponse,
	toProtocolStatus,
} from './projections/index.js'

export type {
	AgentDetailProjectionState,
	AgentRegistryState,
	AgentTreeNode,
	AgentTreeProjectionState,
	AssistantConversationMessageView,
	ChatDebugState,
	ConversationMessageView,
	DebugChatMessage,
	GetAgentDetailResponse,
	GetEventsResponse,
	GetMetricsResponse,
	GlobalMailboxMessage,
	MailboxMessageView,
	MailboxState,
	MetricsState,
	ProjectionEvent,
	ServiceEntry,
	ServicesProjectionState,
	ServiceStatus,
	SessionInfoState,
	SystemConversationMessageView,
	TimelineItem,
	TimelineState,
	ToolCallView,
	ToolConversationMessageView,
	UserConversationMessageView,
} from './projections/index.js'
