import z4 from 'zod/v4'
import { COMMUNICATOR_ROLE, ORCHESTRATOR_ROLE } from '~/core/agents/agent-roles.js'
import type { AgentId } from '~/core/agents/schema.js'
import { agentIdSchema } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { contextEvents } from '~/core/context/state.js'
import { createEventsFactory } from '~/core/events/types'
import type { DomainEvent } from '~/core/events/types.js'
import { llmEvents } from '~/core/llm/state.js'
import { SessionId, sessionIdSchema } from '~/core/sessions/schema.js'
import type { PendingToolResult } from '~/core/tools/schema.js'
import type { ToolCallId } from '~/core/tools/schema.js'
import { toolEvents } from '~/core/tools/state.js'
import type { AgentState, AssistantLLMMessage, LLMMessage } from '../agents/state.js'
import { createTypedReducer } from './reducer.js'

// ============================================================================
// Session events
// ============================================================================

/**
 * Session lifecycle hook name.
 * These correspond to ConfiguredPlugin sessionHooks.
 */
export type SessionHandlerName = 'onSessionReady' | 'onSessionClose'

export const sessionEvents = createEventsFactory({
	events: {
		session_created: z4.object({
			presetId: z4.string(),
			workspaceDir: z4.string().optional(),
			forkedFrom: z4.object({
				sessionId: sessionIdSchema,
				eventIndex: z4.number(),
			}).optional(),
		}),
		session_closed: z4.looseObject({}),
		session_reopened: z4.looseObject({}),
		session_restarted: z4.object({
			resetAgentIds: z4.array(agentIdSchema),
			clearedToolAgentIds: z4.array(agentIdSchema),
		}),
		session_metadata_set: z4.object({
			key: z4.string(),
			value: z4.unknown(),
		}),
		session_handler_started: z4.object({
			handlerName: z4.enum(['onSessionReady', 'onSessionClose']),
			pluginName: z4.string(),
		}),
		session_handler_completed: z4.object({
			handlerName: z4.enum(['onSessionReady', 'onSessionClose']),
			pluginName: z4.string(),
			durationMs: z4.number(),
			error: z4.string().optional(),
		}),
	},
})

export type SessionCreatedEvent = (typeof sessionEvents)['Events']['session_created']
export type SessionClosedEvent = (typeof sessionEvents)['Events']['session_closed']
export type SessionReopenedEvent = (typeof sessionEvents)['Events']['session_reopened']
export type SessionRestartedEvent = (typeof sessionEvents)['Events']['session_restarted']
export type SessionMetadataSetEvent = (typeof sessionEvents)['Events']['session_metadata_set']
export type SessionHandlerStartedEvent = (typeof sessionEvents)['Events']['session_handler_started']
export type SessionHandlerCompletedEvent = (typeof sessionEvents)['Events']['session_handler_completed']

// ============================================================================
// SessionState - POJO for persistence
// ============================================================================

/**
 * Core session state.
 *
 * Plugin-owned fields (todos, workers, services, skills, agentLimits, etc.)
 * are stored as dynamic keys managed by each plugin's state slice.
 * Use `selectPluginState()` from reducer.ts to access them.
 */
export interface SessionState {
	id: SessionId
	presetId: string
	status: 'active' | 'closed'
	agents: Map<AgentId, AgentState>
	createdAt: number
	closedAt?: number
	/** Counter for agent IDs per definition name */
	agentCounters: Map<string, number>
	/** Workspace directory path, if configured */
	workspaceDir?: string
	/** Generic key-value metadata store (tool sets use their own keys) */
	metadata: Map<string, unknown>
	/** If this session was forked from another session */
	forkedFrom?: { sessionId: SessionId; eventIndex: number }
}

// ============================================================================
// Create empty session state (used internally)
// ============================================================================

export const createSessionState = (
	id: SessionId,
	presetId: string,
	timestamp: number,
): SessionState => ({
	id,
	presetId,
	status: 'active',
	agents: new Map(),
	createdAt: timestamp,
	agentCounters: new Map(),
	metadata: new Map(),
})

// ============================================================================
// Tool call conversion helper
// ============================================================================

interface ToolCall {
	id: ToolCallId
	name: string
	input: unknown
}

export const fromLLMToolCall = (tc: { id: string; name: string; input: unknown }): ToolCall => ({
	id: tc.id as ToolCallId,
	name: tc.name,
	input: tc.input,
})

export const fromLLMToolCalls = (llmToolCalls: Array<{ id: string; name: string; input: unknown }>): ToolCall[] => llmToolCalls.map(fromLLMToolCall)

// ============================================================================
// Core reducer - handles agent state, messages, session lifecycle
// ============================================================================

export const coreReducer = createTypedReducer(
	[sessionEvents, agentEvents, toolEvents, llmEvents, contextEvents],
	(state, event) => {
		switch (event.type) {
			case 'session_closed':
				return {
					...state,
					status: 'closed',
					closedAt: event.timestamp,
				}

			case 'session_reopened':
				return {
					...state,
					status: 'active',
					closedAt: undefined,
				}

			case 'agent_spawned': {
				// Increment agent counter for this definition name
				const newAgentCounters = new Map(state.agentCounters)
				const currentCount = newAgentCounters.get(event.definitionName) ?? 0
				newAgentCounters.set(event.definitionName, currentCount + 1)

				const newState = addAgent(
					{ ...state, agentCounters: newAgentCounters },
					{
						id: event.agentId,
						definitionName: event.definitionName,
						parentId: event.parentId,
						status: 'pending',
						conversationHistory: [],
						preamble: [],
						pendingToolCalls: [],
						pendingToolResults: [],
						pendingMessages: [],
						typedInput: event.typedInput,
					},
				)
				return newState
			}

			case 'agent_state_changed':
				return updateAgent(state, event.agentId, (agent) => ({
					...agent,
					status: event.toState,
				}))

			case 'inference_started':
				return updateAgent(state, event.agentId, (agent) => ({
					...agent,
					status: 'inferring',
					pendingMessages: [...agent.pendingMessages, ...event.messages],
				}))

			case 'inference_completed': {
				const toolCalls = fromLLMToolCalls(event.response.toolCalls)

				const assistantMessage: AssistantLLMMessage = {
					role: 'assistant',
					content: event.response.content ?? '',
					toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
				}

				return updateAgent(state, event.agentId, (agent) => {
					const hasToolCalls = toolCalls.length > 0

					return {
						...agent,
						status: hasToolCalls ? 'tool_exec' : 'pending',
						conversationHistory: [...agent.conversationHistory, ...agent.pendingMessages, assistantMessage],
						pendingToolCalls: toolCalls,
						pendingMessages: [],
						pendingToolResults: [],
					}
				})
			}

			case 'inference_failed':
				return updateAgent(state, event.agentId, (agent) => ({
					...agent,
					status: 'errored',
					conversationHistory: [...agent.conversationHistory, ...agent.pendingMessages],
					pendingMessages: [],
				}))

			case 'tool_completed': {
				return updateAgent(state, event.agentId, (agent) => {
					const remaining = agent.pendingToolCalls.filter(
						(tc) => tc.id !== event.toolCallId,
					)
					const toolName = agent.executingToolCall?.toolName
						?? agent.pendingToolCalls.find((tc) => tc.id === event.toolCallId)?.name
						?? 'unknown'
					const pendingToolResult: PendingToolResult = {
						toolCallId: event.toolCallId,
						toolName,
						timestamp: event.timestamp,
						isError: false,
						content: event.result,
					}
					return {
						...agent,
						pendingToolCalls: remaining,
						pendingToolResults: [...agent.pendingToolResults, pendingToolResult],
						status: remaining.length === 0 ? 'pending' : 'tool_exec',
						executingToolCall: undefined,
					}
				})
			}

			case 'tool_failed': {
				return updateAgent(state, event.agentId, (agent) => {
					const remaining = agent.pendingToolCalls.filter(
						(tc) => tc.id !== event.toolCallId,
					)
					const toolName = agent.executingToolCall?.toolName
						?? agent.pendingToolCalls.find((tc) => tc.id === event.toolCallId)?.name
						?? 'unknown'
					const pendingToolResult: PendingToolResult = {
						toolCallId: event.toolCallId,
						toolName,
						timestamp: event.timestamp,
						isError: true,
						content: event.error,
					}
					return {
						...agent,
						pendingToolCalls: remaining,
						pendingToolResults: [...agent.pendingToolResults, pendingToolResult],
						status: remaining.length === 0 ? 'pending' : 'tool_exec',
						executingToolCall: undefined,
					}
				})
			}

			case 'context_compacted':
				return updateAgent(state, event.agentId, (agent) => ({
					...agent,
					conversationHistory: event.newConversationHistory.map((m) => {
						switch (m.role) {
							case 'user':
								return {
									role: 'user' as const,
									content: m.content,
									sourceMessageIds: [],
								}
							case 'assistant':
								return {
									role: 'assistant' as const,
									content: m.content,
								}
							case 'system':
								return {
									role: 'system' as const,
									content: m.content,
								}
						}
					}),
				}))

			case 'tool_started':
				return updateAgent(state, event.agentId, (agent) => ({
					...agent,
					executingToolCall: {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						startedAt: event.timestamp,
					},
				}))

			case 'session_restarted': {
				const newAgents = new Map(state.agents)

				for (const [agentId, agent] of state.agents) {
					let updated = agent
					let changed = false

					if (agent.status === 'inferring' || agent.status === 'errored') {
						updated = {
							...updated,
							status: 'pending' as const,
							pendingMessages: [],
						}
						changed = true
					}

					if (agent.executingToolCall !== undefined) {
						updated = { ...updated, executingToolCall: undefined }
						changed = true
					}

					if (changed) {
						newAgents.set(agentId, updated)
					}
				}

				return { ...state, agents: newAgents }
			}

			case 'agent_conversation_spliced':
				return updateAgent(state, event.agentId, (agent) => {
					const newHistory = [...agent.conversationHistory]
					newHistory.splice(event.start, event.deleteCount, ...(event.insert ?? []))
					return {
						...agent,
						conversationHistory: newHistory,
						pendingToolCalls: [],
						pendingToolResults: [],
						pendingMessages: [],
						executingToolCall: undefined,
						status: 'pending' as const,
					}
				})

			case 'session_created': {
				let updated = state
				if (event.workspaceDir) {
					updated = { ...updated, workspaceDir: event.workspaceDir }
				}
				if (event.forkedFrom) {
					updated = { ...updated, forkedFrom: event.forkedFrom }
				}
				return updated
			}

			case 'handler_started':
				return state

			case 'handler_completed': {
				if (event.handlerName === 'onStart') {
					return updateAgent(state, event.agentId, (agent) => ({
						...agent,
						onStartCalled: true,
					}))
				}
				return state
			}

			case 'preamble_added':
				return updateAgent(state, event.agentId, (agent) => ({
					...agent,
					preamble: [...agent.preamble, ...event.messages],
				}))

			case 'session_handler_started':
			case 'session_handler_completed':
				return state

			case 'session_metadata_set': {
				const newMetadata = new Map(state.metadata)
				newMetadata.set(event.key, event.value)
				return { ...state, metadata: newMetadata }
			}

			case 'agent_paused':
				return updateAgent(state, event.agentId, (agent) => ({
					...agent,
					status: 'paused',
					pauseReason: event.reason,
					pauseMessage: event.message,
				}))

			case 'agent_resumed':
				return updateAgent(state, event.agentId, (agent) => ({
					...agent,
					status: 'pending',
					pauseReason: undefined,
					pauseMessage: undefined,
				}))

			default:
				// Plugin events are handled by their own state slices (composed in apply-event.ts)
				return state
		}
	},
)

// ============================================================================
// Reconstruct session state from events
// ============================================================================

export const isSessionCreatedEvent = (event: DomainEvent): event is SessionCreatedEvent => event.type === 'session_created'

export const reconstructSessionState = (
	events: DomainEvent[],
	reducer: (state: SessionState, event: DomainEvent) => SessionState,
): SessionState | null => {
	if (events.length === 0) return null

	const firstEvent = events[0]
	if (!isSessionCreatedEvent(firstEvent)) {
		throw new Error('First event must be session_created')
	}

	const initial = createSessionState(
		firstEvent.sessionId,
		firstEvent.presetId,
		firstEvent.timestamp,
	)

	return events.reduce(reducer, initial)
}

// ============================================================================
// Recovery helpers
// ============================================================================

export const checkRecoveryNeeded = (state: SessionState): {
	resetAgentIds: AgentId[]
	clearedToolAgentIds: AgentId[]
} | null => {
	const resetAgentIds: AgentId[] = []
	const clearedToolAgentIds: AgentId[] = []

	for (const [agentId, agent] of state.agents) {
		if (agent.status === 'inferring' || agent.status === 'errored') {
			resetAgentIds.push(agentId)
		}
		if (agent.executingToolCall !== undefined) {
			clearedToolAgentIds.push(agentId)
		}
	}

	if (resetAgentIds.length === 0 && clearedToolAgentIds.length === 0) {
		return null
	}

	return { resetAgentIds, clearedToolAgentIds }
}

// ============================================================================
// Helpers
// ============================================================================

const addAgent = (state: SessionState, agent: AgentState): SessionState => {
	const newAgents = new Map(state.agents)
	newAgents.set(agent.id, agent)
	return { ...state, agents: newAgents }
}

const updateAgent = (
	state: SessionState,
	agentId: AgentId,
	updater: (agent: AgentState) => AgentState,
): SessionState => {
	const agent = state.agents.get(agentId)
	if (!agent) {
		throw new Error(`Agent not found: ${agentId}`)
	}

	const newAgents = new Map(state.agents)
	newAgents.set(agentId, updater(agent))
	return { ...state, agents: newAgents }
}

// ============================================================================
// Query helpers
// ============================================================================

export const getOrchestratorId = (state: SessionState): AgentId | null => {
	for (const agent of state.agents.values()) {
		if (agent.definitionName === ORCHESTRATOR_ROLE) return agent.id
	}
	return null
}

export const getCommunicatorId = (state: SessionState): AgentId | null => {
	for (const agent of state.agents.values()) {
		if (agent.definitionName === COMMUNICATOR_ROLE) return agent.id
	}
	return null
}

export const getEntryAgentId = (state: SessionState): AgentId | null => {
	return getCommunicatorId(state) ?? getOrchestratorId(state)
}

export const getAgentState = (state: SessionState, agentId: AgentId): AgentState | null => {
	return state.agents.get(agentId) ?? null
}

export const getNextAgentSeq = (state: SessionState, definitionName: string): number => {
	return (state.agentCounters.get(definitionName) ?? 0) + 1
}
