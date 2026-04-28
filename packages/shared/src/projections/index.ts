// Projection event type
export type { ProjectionEvent } from './events.js'

// Types
export type {
	AgentTreeNode,
	AssistantConversationMessageView,
	ConversationMessageView,
	DebugChatMessage,
	GetAgentDetailResponse,
	GetEventsResponse,
	GetMetricsResponse,
	GlobalMailboxMessage,
	MailboxMessageView,
	SystemConversationMessageView,
	TimelineItem,
	ToolCallView,
	ToolConversationMessageView,
	UserConversationMessageView,
} from './types.js'

// Protocol status
export { toProtocolStatus } from './protocol-status.js'

// Agent registry
export type { AgentRegistryState } from './agent-registry.js'
export { applyEventToAgentRegistry, createAgentRegistryState, getAgentName } from './agent-registry.js'

// Agent tree projection (self-contained — no SessionState)
export type { AgentTreeProjectionState } from './agent-tree-projection.js'
export { applyEventToAgentTree, buildAgentTreeFromProjection, createAgentTreeProjectionState } from './agent-tree-projection.js'

// Metrics
export type { MetricsState } from './metrics.js'
export { applyEventToMetrics, createMetricsState, metricsStateToResponse } from './metrics.js'

// Timeline
export type { TimelineState } from './timeline.js'
export { applyEventToTimeline, createTimelineState, getTimelineItems } from './timeline.js'

// Mailbox projection
export type { MailboxState } from './mailbox.js'
export { applyEventToMailbox, createMailboxState, getMailboxMessages } from './mailbox.js'

// Chat debug
export type { ChatDebugState } from './chat-debug.js'
export { applyEventToChatDebug, createChatDebugState, getChatDebugMessages } from './chat-debug.js'

// Agent detail projection (self-contained — no SessionState)
export type { AgentDetailProjectionState } from './agent-detail-projection.js'
export { applyEventToAgentDetail, createAgentDetailProjectionState, getAgentDetail } from './agent-detail-projection.js'

// Session info projection
export type { SessionInfoState } from './session-info.js'
export { applyEventToSessionInfo, createSessionInfoState } from './session-info.js'

// Services projection
export type { ServiceEntry, ServicesProjectionState, ServiceStatus } from './services-projection.js'
export { applyEventToServices, createServicesProjectionState } from './services-projection.js'
