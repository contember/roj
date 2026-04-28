/**
 * View model types for client-side projections.
 */

import type {
	AgentCounters,
	AgentId,
	AgentPauseReason,
	AskUserInputType,
	ChatMessageId,
	DomainEvent,
	LLMCallId,
	MessageId,
	ProtocolAgentStatus,
	ToolCallId,
} from '@roj-ai/sdk'

// ============================================================================
// Debug view types (computed client-side from SessionState)
// ============================================================================

/**
 * Agent tree node for visualization.
 */
export interface AgentTreeNode {
	id: AgentId
	definitionName: string
	status: ProtocolAgentStatus
	parentId: AgentId | null
	children: AgentTreeNode[]
	mailboxCount: number
	pendingToolCalls: number
	isExecuting: boolean
	cost: number
}

/**
 * Agent detail response - computed client-side from SessionState.
 */
export interface GetAgentDetailResponse {
	id: AgentId
	definitionName: string
	status: ProtocolAgentStatus
	parentId: AgentId | null
	mailbox: MailboxMessageView[]
	conversationHistory: ConversationMessageView[]
	pendingToolCalls: ToolCallView[]
	counters: AgentCounters
	loadedSkills: { id: string; name: string; loadedAt: number }[]
	cost: number
	typedInput?: unknown
	pauseReason?: AgentPauseReason
	pauseMessage?: string
}

export interface MailboxMessageView {
	id: MessageId
	from: string // Can be AgentId, WorkerId, "user", or system role
	content: string
	timestamp: number
	consumed: boolean
}

export type ConversationMessageView =
	| UserConversationMessageView
	| AssistantConversationMessageView
	| ToolConversationMessageView
	| SystemConversationMessageView

export interface UserConversationMessageView {
	role: 'user'
	content: string
	fullContent: string
	timestamp?: number
}

export interface AssistantConversationMessageView {
	role: 'assistant'
	content: string
	fullContent: string
	toolCalls?: { id: ToolCallId; name: string; input: unknown }[]
	timestamp?: number
	cost?: number
	llmCallId?: LLMCallId
	promptTokens?: number
	cachedTokens?: number
	cacheWriteTokens?: number
}

export interface ToolConversationMessageView {
	role: 'tool'
	toolCallId: ToolCallId
	content: string
	fullContent: string
	isError: boolean
	timestamp?: number
}

export interface SystemConversationMessageView {
	role: 'system'
	content: string
	fullContent: string
	timestamp?: number
}

export interface ToolCallView {
	id: ToolCallId
	name: string
	input: unknown
	status: 'pending' | 'executing' | 'completed' | 'failed'
	result?: unknown
	error?: string
}

// ============================================================================
// Events response type
// ============================================================================

/**
 * Events response - used by sessions.getEvents RPC method.
 */
export interface GetEventsResponse {
	events: DomainEvent[]
	total: number
	lastIndex: number
}

// ============================================================================
// Metrics types
// ============================================================================

/**
 * Metrics view - computed client-side from events.
 */
export interface ProviderMetrics {
	llmCalls: number
	totalTokens: number
	promptTokens: number
	completionTokens: number
	totalCost: number
}

export interface GetMetricsResponse {
	totalTokens: number
	promptTokens: number
	completionTokens: number
	totalCost?: number
	llmCalls: number
	toolCalls: number
	agentCount: number
	durationMs: number
	byProvider: Record<string, ProviderMetrics>
}

// ============================================================================
// Timeline types
// ============================================================================

/**
 * Timeline item representing an LLM call, tool execution, or context compaction.
 */
export interface TimelineItem {
	id: string
	type: 'llm' | 'tool' | 'compaction'
	agentId: AgentId
	agentName: string
	startedAt: number
	completedAt?: number
	durationMs?: number
	status: 'running' | 'success' | 'error'
	// LLM specific
	model?: string
	promptTokens?: number
	completionTokens?: number
	cachedTokens?: number
	cacheWriteTokens?: number
	cost?: number
	llmCallId?: LLMCallId
	// Tool specific
	toolName?: string
	toolCallId?: ToolCallId
	toolInput?: unknown
	toolResult?: unknown
	// Compaction specific
	originalTokens?: number
	compactedTokens?: number
	messagesRemoved?: number
	// Error
	error?: string
}

// ============================================================================
// Global mailbox types
// ============================================================================

/**
 * Message in the global mailbox view.
 */
export interface GlobalMailboxMessage {
	id: MessageId
	fromAgentId: string // Can be AgentId, "user", or system role
	fromAgentName: string
	toAgentId: AgentId
	toAgentName: string
	content: string
	timestamp: number
	consumed: boolean
}

// ============================================================================
// Chat debug types
// ============================================================================

/**
 * Debug chat message with links to related entities.
 */
export interface DebugChatMessage {
	// Base
	type: 'user_message' | 'agent_message' | 'ask_user'
	messageId: MessageId | ChatMessageId
	content: string
	timestamp: number
	eventIndex: number

	// Links
	agentId?: AgentId
	agentName?: string
	llmCallId?: LLMCallId
	toolCallId?: ToolCallId
	mailboxMessageId?: MessageId

	// Type-specific
	format?: 'text' | 'markdown'
	inputType?: AskUserInputType
	answered?: boolean
	answer?: unknown
}
