// ============================================================================
// Agent status
// ============================================================================

import z4 from 'zod/v4'
import type { AgentId } from '~/core/agents/schema.js'
import { agentIdSchema } from '~/core/agents/schema.js'
import { createEventsFactory } from '~/core/events/types'
import type { ToolResultContent } from '~/core/llm/llm-log-types.js'
import type { ChatMessageContentItem } from '~/core/llm/llm-log-types.js'
import type { LLMMetrics } from '~/core/llm/state.js'
import type { PendingToolResult, ToolCallId } from '~/core/tools/schema.js'
import { MessageId } from '../../plugins/mailbox/schema.js'

export { MessageId }

// ============================================================================
// Agent events
// ============================================================================

/**
 * Union of all possible handler results (stored in handler_completed event).
 */
export type HandlerResult =
	| null
	| { action: 'skip'; response: { content: string | null; toolCalls: Array<{ id: string; name: string; input: unknown }> } }
	| { action: 'modify'; response: { content: string | null; toolCalls: Array<{ id: string; name: string; input: unknown }> } }
	| { action: 'retry' }
	| { action: 'block'; reason: string }
	| { action: 'replace'; toolCall: { id: string; name: string; input: unknown } }
	| { action: 'modify'; result: { isError: boolean; content: unknown } }
	| { action: 'pause'; reason?: string }

export const agentEvents = createEventsFactory({
	events: {
		agent_spawned: z4.object({
			agentId: agentIdSchema,
			definitionName: z4.string(),
			parentId: agentIdSchema.nullable(),
			typedInput: z4.unknown().optional(),
		}),
		agent_state_changed: z4.object({
			agentId: agentIdSchema,
			fromState: z4.enum(['pending', 'inferring', 'tool_exec', 'errored', 'paused']),
			toState: z4.enum(['pending', 'inferring', 'tool_exec', 'errored', 'paused']),
		}),
		handler_started: z4.object({
			agentId: agentIdSchema,
			handlerName: z4.enum(['onStart', 'beforeInference', 'afterInference', 'beforeToolCall', 'afterToolCall', 'onComplete', 'onError', 'onPause']),
		}),
		handler_completed: z4.object({
			agentId: agentIdSchema,
			handlerName: z4.enum(['onStart', 'beforeInference', 'afterInference', 'beforeToolCall', 'afterToolCall', 'onComplete', 'onError', 'onPause']),
			result: z4.unknown(), // HandlerResult - too complex for Zod
		}),
		preamble_added: z4.object({
			agentId: agentIdSchema,
			messages: z4.array(z4.custom<LLMMessage>()),
		}),
		agent_paused: z4.object({
			agentId: agentIdSchema,
			reason: z4.enum(['limit', 'handler', 'manual']),
			message: z4.string().optional(),
		}),
		agent_resumed: z4.object({
			agentId: agentIdSchema,
		}),
		agent_input_consumed: z4.object({
			agentId: agentIdSchema,
			sourcePlugins: z4.array(z4.string()),
		}),
		communicator_linked: z4.object({
			communicatorId: agentIdSchema,
			orchestratorId: agentIdSchema,
		}),
		agent_conversation_spliced: z4.object({
			agentId: agentIdSchema,
			start: z4.number().int().min(0),
			deleteCount: z4.number().int().min(0),
			insert: z4.array(z4.custom<LLMMessage>()).optional(),
		}),
	},
})

export type AgentSpawnedEvent = (typeof agentEvents)['Events']['agent_spawned']
export type AgentStateChangedEvent = (typeof agentEvents)['Events']['agent_state_changed']
export type HandlerStartedEvent = (typeof agentEvents)['Events']['handler_started']
export type HandlerCompletedEvent = (typeof agentEvents)['Events']['handler_completed']
export type PreambleAddedEvent = (typeof agentEvents)['Events']['preamble_added']
export type AgentPausedEvent = (typeof agentEvents)['Events']['agent_paused']
export type AgentResumedEvent = (typeof agentEvents)['Events']['agent_resumed']
export type AgentInputConsumedEvent = (typeof agentEvents)['Events']['agent_input_consumed']
export type CommunicatorLinkedEvent = (typeof agentEvents)['Events']['communicator_linked']
export type AgentConversationSplicedEvent = (typeof agentEvents)['Events']['agent_conversation_spliced']

// ============================================================================
// Agent status
// ============================================================================

export type AgentStatus = 'pending' | 'inferring' | 'tool_exec' | 'errored' | 'paused'

/**
 * Reason why an agent was paused.
 * - 'limit' — agent hit a hard limit (replaces limitStopped)
 * - 'handler' — handler returned { action: 'pause' }
 * - 'manual' — paused via API call
 */
export type AgentPauseReason = 'limit' | 'handler' | 'manual'

// ============================================================================
// LLM Message types (unified for both LLM API and conversation history)
// ============================================================================

/**
 * Prompt cache breakpoint marker.
 * When set on an LLMMessage, providers place `cache_control` on the LAST
 * content block of the mapped message (regardless of block type), marking it
 * as a prompt cache checkpoint.
 *
 * `ttl: '1h'` opts into Anthropic's 1-hour cache tier (write cost 2× input,
 * read still 0.1×). Useful for long-lived agents whose prompt cache would
 * otherwise expire between user turns. Omit for the default 5-minute tier.
 */
export type LLMMessageCacheControl = { type: 'ephemeral'; ttl?: '5m' | '1h' }

/**
 * User message - from mailbox or direct input.
 * Supports multimodal content (text + images).
 */
export interface UserLLMMessage {
	role: 'user'
	content: string | ChatMessageContentItem[]
	/** Track which mailbox messages were included (conversation metadata) */
	sourceMessageIds?: MessageId[]
	/** Marks this message as a prompt cache breakpoint. */
	cacheControl?: LLMMessageCacheControl
}

/**
 * Provider chain-of-thought blocks, kept opaque (OpenRouter `reasoning_details`).
 *
 * The provider requires the exact sequence it produced to come back verbatim, so
 * these are never parsed, reordered or normalized — only stored and echoed. The
 * shape is provider- and model-specific and changes without notice; nothing in
 * the SDK may depend on it.
 */
export type ReasoningDetails = unknown[]

/**
 * Anthropic extended-thinking blocks (`thinking` and `redacted_thinking`), kept opaque
 * for the same reason as {@link ReasoningDetails}: each carries a `signature` the API
 * verifies, so an edited block is worse than a missing one.
 *
 * Deliberately a separate field rather than sharing `reasoningDetails`. A session can
 * change model mid-conversation, so one field would eventually put Anthropic-shaped
 * blocks in front of OpenRouter or the reverse. Two fields make that case degrade to
 * "absent", which both providers accept, instead of "wrong shape", which neither does.
 */
export type ThinkingBlocks = unknown[]

/**
 * Assistant message - LLM response.
 */
export interface AssistantLLMMessage {
	role: 'assistant'
	content: string
	toolCalls?: ToolCall[]
	/** Reasoning blocks to echo back on later requests, so the model keeps its chain of thought across tool calls. */
	reasoningDetails?: ReasoningDetails
	/** Anthropic thinking blocks to replay on later requests. Required by the API during tool use. */
	thinkingBlocks?: ThinkingBlocks
	/** Marks this message as a prompt cache breakpoint. */
	cacheControl?: LLMMessageCacheControl
}

/**
 * Tool result message - response from tool execution.
 */
export interface ToolLLMMessage {
	role: 'tool'
	content: ToolResultContent
	toolCallId: ToolCallId
	/** Tool name (conversation metadata) */
	toolName?: string
	/** Whether the tool execution failed (conversation metadata) */
	isError?: boolean
	/** When the tool completed (conversation metadata) */
	timestamp?: number
	/** Marks this message as a prompt cache breakpoint. */
	cacheControl?: LLMMessageCacheControl
}

/**
 * System message - injected context (e.g., from context compaction).
 */
export interface SystemLLMMessage {
	role: 'system'
	content: string
	/** Marks this message as a prompt cache breakpoint. */
	cacheControl?: LLMMessageCacheControl
}

/**
 * Unified message type for LLM communication and conversation history.
 */
export type LLMMessage =
	| UserLLMMessage
	| AssistantLLMMessage
	| ToolLLMMessage
	| SystemLLMMessage

// ============================================================================
// AgentState - POJO for persistence
// ============================================================================

export interface AgentState {
	id: AgentId
	definitionName: string
	parentId: AgentId | null
	status: AgentStatus
	conversationHistory: LLMMessage[]
	/** Immutable preamble messages from onStart handlers - never compacted, always prepended before conversation */
	preamble: LLMMessage[]
	pendingToolCalls: ToolCall[]
	/** Currently executing tool call (set by tool_started, cleared by tool_completed/tool_failed) */
	executingToolCall?: {
		toolCallId: ToolCallId
		toolName: string
		startedAt: number
	}
	/** Tool results awaiting LLM processing (set by tool_completed/tool_failed, cleared by inference_completed) */
	pendingToolResults: PendingToolResult[]
	/** Messages pending addition to history (set by inference_started, committed by inference_completed) */
	pendingMessages: LLMMessage[]
	/** Typed input for agents with inputSchema (set by agent_spawned event) */
	typedInput?: unknown
	/** Whether onStart handler has been executed (for first-run initialization) */
	onStartCalled?: boolean
	/** Reason for pause (set when status is 'paused') */
	pauseReason?: AgentPauseReason
	/** Human-readable pause message */
	pauseMessage?: string
	/** Metrics from the most recent completed inference — used by plugins (e.g. context-compact) to size context against the provider-reported truth. */
	lastInferenceMetrics?: LLMMetrics
	/** Consecutive inference_failed count since the last committed turn — drives the outer error-resume backoff. */
	consecutiveInferenceFailures?: number
	/** Timestamp of the most recent inference_failed — drives the outer error-resume backoff. */
	lastInferenceFailureAt?: number
}

// ============================================================================
// Tool types
// ============================================================================

export interface ToolCall {
	id: ToolCallId
	name: string
	input: unknown
}

export interface ToolResult {
	toolCallId: ToolCallId
	result: unknown
	isError: boolean
}

// ============================================================================
// AgentState tree helpers
// ============================================================================

export const getChildren = (
	session: { agents: Map<AgentId, AgentState> },
	parentId: AgentId,
): AgentState[] => {
	const children: AgentState[] = []
	for (const agent of session.agents.values()) {
		if (agent.parentId === parentId) {
			children.push(agent)
		}
	}
	return children
}

export const getParent = (
	session: { agents: Map<AgentId, AgentState> },
	agent: AgentState,
): AgentState | null => {
	if (!agent.parentId) return null
	return session.agents.get(agent.parentId) ?? null
}

// Factory for creating AgentState (useful for tests)
// ============================================================================

/**
 * Create a new AgentState with default values.
 * Useful for tests to avoid maintaining inline mocks when new fields are added.
 */
export const createAgentState = (
	id: AgentId,
	definitionName: string,
	overrides: Partial<AgentState> = {},
): AgentState => ({
	id,
	definitionName,
	parentId: null,
	status: 'pending',
	conversationHistory: [],
	preamble: [],
	pendingToolCalls: [],
	pendingToolResults: [],
	pendingMessages: [],
	...overrides,
})
