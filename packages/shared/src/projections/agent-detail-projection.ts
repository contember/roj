/**
 * Agent detail projection - self-contained projection for agent detail views.
 *
 * Replaces useAgentDetail (client) and buildAgentDetail (CLI) that needed full SessionState.
 * Tracks per-agent: conversation history, tool calls, mailbox, counters, skills.
 */

import type { AgentCounters, AgentId, AgentPauseReason, LLMCallId, MessageId, ToolCallId } from '@roj-ai/sdk'
import { contentToString } from '../lib/domain-utils.js'
import type { ProjectionEvent } from './events.js'
import { toProtocolStatus } from './protocol-status.js'
import type { ConversationMessageView, GetAgentDetailResponse, MailboxMessageView, ToolCallView } from './types.js'

// ============================================================================
// Agent view model (internal per-agent state)
// ============================================================================

interface LLMMessage {
	role: 'user' | 'assistant' | 'tool' | 'system'
	content: string | Array<{ type: string; text?: string }>
	toolCalls?: Array<{ id: ToolCallId; name: string; input: unknown }>
	toolCallId?: ToolCallId
	isError?: boolean
	sourceMessageIds?: MessageId[]
	timestamp?: number
	cost?: number
	llmCallId?: LLMCallId
	promptTokens?: number
	cachedTokens?: number
	cacheWriteTokens?: number
}

interface ToolCall {
	id: ToolCallId
	name: string
	input: unknown
}

interface PendingToolResult {
	toolCallId: ToolCallId
	toolName: string
	timestamp: number
	isError: boolean
	content: string | Array<{ type: string; text?: string }>
}

interface AgentViewModel {
	id: AgentId
	definitionName: string
	status: 'pending' | 'inferring' | 'tool_exec' | 'errored' | 'paused'
	parentId: AgentId | null
	conversationHistory: LLMMessage[]
	pendingToolCalls: ToolCall[]
	executingToolCall?: { toolCallId: ToolCallId; toolName: string; startedAt: number }
	pendingToolResults: PendingToolResult[]
	/** Messages pending addition to history (set by inference_started, committed by inference_completed) */
	pendingMessages: LLMMessage[]
	typedInput?: unknown
	pauseReason?: AgentPauseReason
	pauseMessage?: string
	cost: number
}

interface MailboxEntry {
	id: MessageId
	from: string
	content: string
	timestamp: number
	consumed: boolean
}

interface LoadedSkillEntry {
	id: string
	name: string
	loadedAt: number
}

// ============================================================================
// State
// ============================================================================

export interface AgentDetailProjectionState {
	agents: Map<AgentId, AgentViewModel>
	agentMailboxes: Map<AgentId, MailboxEntry[]>
	agentCounters: Map<AgentId, AgentCounters>
	agentSkills: Map<AgentId, LoadedSkillEntry[]>
}

export function createAgentDetailProjectionState(): AgentDetailProjectionState {
	return {
		agents: new Map(),
		agentMailboxes: new Map(),
		agentCounters: new Map(),
		agentSkills: new Map(),
	}
}

const createDefaultCounters = (): AgentCounters => ({
	inferenceCount: 0,
	toolCallCount: 0,
	spawnedAgentCount: 0,
	messagesSentCount: 0,
	consecutiveToolFailures: {},
	recentToolCallHashes: [],
	recentResponseHashes: [],
})

// ============================================================================
// Reducer
// ============================================================================

export function applyEventToAgentDetail(state: AgentDetailProjectionState, event: ProjectionEvent): AgentDetailProjectionState {
	switch (event.type) {
		// ---- Core agent lifecycle ----

		case 'agent_spawned': {
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, {
				id: event.agentId,
				definitionName: event.definitionName,
				parentId: event.parentId,
				status: 'pending',
				conversationHistory: [],
				pendingToolCalls: [],
				pendingToolResults: [],
				pendingMessages: [],
				typedInput: event.typedInput,
				cost: 0,
			})

			const newCounters = new Map(state.agentCounters)
			newCounters.set(event.agentId, createDefaultCounters())

			// Increment parent's spawnedAgentCount
			if (event.parentId) {
				const parentCounters = newCounters.get(event.parentId)
				if (parentCounters) {
					newCounters.set(event.parentId, {
						...parentCounters,
						spawnedAgentCount: parentCounters.spawnedAgentCount + 1,
					})
				}
			}

			return { ...state, agents: newAgents, agentCounters: newCounters }
		}

		case 'agent_state_changed': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, { ...agent, status: event.toState })
			return { ...state, agents: newAgents }
		}

		case 'inference_started': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, {
				...agent,
				status: 'inferring',
				pendingMessages: event.messages.map((m) => ({ ...m, timestamp: event.timestamp })),
			})
			return { ...state, agents: newAgents }
		}

		case 'inference_completed': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state

			const toolCalls: ToolCall[] = event.response.toolCalls.map((tc) => ({
				id: tc.id,
				name: tc.name,
				input: tc.input,
			}))

			const assistantMessage: LLMMessage = {
				role: 'assistant',
				content: event.response.content ?? '',
				toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
				timestamp: event.timestamp,
				cost: event.metrics.cost ?? undefined,
				llmCallId: event.llmCallId ?? undefined,
				promptTokens: event.metrics.promptTokens,
				cachedTokens: event.metrics.cachedTokens ?? undefined,
				cacheWriteTokens: event.metrics.cacheWriteTokens ?? undefined,
			}

			const hasToolCalls = toolCalls.length > 0

			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, {
				...agent,
				status: hasToolCalls ? 'tool_exec' : 'pending',
				conversationHistory: [...agent.conversationHistory, ...agent.pendingMessages, assistantMessage],
				pendingToolCalls: toolCalls,
				pendingMessages: [],
				pendingToolResults: [],
				cost: agent.cost + (event.metrics.cost ?? 0),
			})

			// Update counters
			const counters = state.agentCounters.get(event.agentId)
			if (counters) {
				const newCounters = new Map(state.agentCounters)
				newCounters.set(event.agentId, {
					...counters,
					inferenceCount: counters.inferenceCount + 1,
				})
				return { ...state, agents: newAgents, agentCounters: newCounters }
			}

			return { ...state, agents: newAgents }
		}

		case 'inference_failed': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, {
				...agent,
				status: 'errored',
				pendingMessages: [],
			})
			return { ...state, agents: newAgents }
		}

		case 'tool_started': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, {
				...agent,
				executingToolCall: {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					startedAt: event.timestamp,
				},
			})

			// Update counters
			const counters = state.agentCounters.get(event.agentId)
			if (counters) {
				const newCounters = new Map(state.agentCounters)
				newCounters.set(event.agentId, {
					...counters,
					toolCallCount: counters.toolCallCount + 1,
				})
				return { ...state, agents: newAgents, agentCounters: newCounters }
			}

			return { ...state, agents: newAgents }
		}

		case 'tool_completed': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const remaining = agent.pendingToolCalls.filter((tc) => tc.id !== event.toolCallId)
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

			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, {
				...agent,
				pendingToolCalls: remaining,
				pendingToolResults: [...agent.pendingToolResults, pendingToolResult],
				status: remaining.length === 0 ? 'pending' : 'tool_exec',
				executingToolCall: undefined,
			})

			// Reset consecutive failures for this tool
			const counters = state.agentCounters.get(event.agentId)
			if (counters) {
				const { [toolName]: _, ...restFailures } = counters.consecutiveToolFailures
				const newCounters = new Map(state.agentCounters)
				newCounters.set(event.agentId, {
					...counters,
					consecutiveToolFailures: restFailures,
				})
				return { ...state, agents: newAgents, agentCounters: newCounters }
			}

			return { ...state, agents: newAgents }
		}

		case 'tool_failed': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const remaining = agent.pendingToolCalls.filter((tc) => tc.id !== event.toolCallId)
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

			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, {
				...agent,
				pendingToolCalls: remaining,
				pendingToolResults: [...agent.pendingToolResults, pendingToolResult],
				status: remaining.length === 0 ? 'pending' : 'tool_exec',
				executingToolCall: undefined,
			})

			// Increment consecutive failures for this tool
			const counters = state.agentCounters.get(event.agentId)
			if (counters) {
				const currentEntry = counters.consecutiveToolFailures[toolName]
				const newCounters = new Map(state.agentCounters)
				newCounters.set(event.agentId, {
					...counters,
					consecutiveToolFailures: {
						...counters.consecutiveToolFailures,
						[toolName]: { count: (currentEntry?.count ?? 0) + 1, lastError: event.error },
					},
				})
				return { ...state, agents: newAgents, agentCounters: newCounters }
			}

			return { ...state, agents: newAgents }
		}

		case 'context_compacted': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, {
				...agent,
				conversationHistory: event.newConversationHistory.map((m): LLMMessage => ({
					role: m.role,
					content: m.content,
				})),
			})
			return { ...state, agents: newAgents }
		}

		case 'agent_paused': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, {
				...agent,
				status: 'paused',
				pauseReason: event.reason,
				pauseMessage: event.message,
			})
			return { ...state, agents: newAgents }
		}

		case 'agent_resumed': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, {
				...agent,
				status: 'pending',
				pauseReason: undefined,
				pauseMessage: undefined,
			})

			// Reset counters on resume
			const counters = state.agentCounters.get(event.agentId)
			if (counters) {
				const newCounters = new Map(state.agentCounters)
				newCounters.set(event.agentId, {
					...counters,
					inferenceCount: 0,
					toolCallCount: 0,
					spawnedAgentCount: 0,
					messagesSentCount: 0,
					consecutiveToolFailures: {},
					recentToolCallHashes: [],
					recentResponseHashes: [],
				})
				return { ...state, agents: newAgents, agentCounters: newCounters }
			}

			return { ...state, agents: newAgents }
		}

		case 'session_restarted': {
			const newAgents = new Map(state.agents)
			for (const [agentId, agent] of state.agents) {
				let updated = agent
				let changed = false

				if (agent.status === 'inferring') {
					updated = { ...updated, status: 'pending' as const, pendingMessages: [] }
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

		case 'agent_conversation_spliced': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const newHistory = [...agent.conversationHistory]
			newHistory.splice(event.start, event.deleteCount, ...(event.insert ?? []))
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, {
				...agent,
				conversationHistory: newHistory,
				pendingToolCalls: [],
				pendingToolResults: [],
				pendingMessages: [],
				executingToolCall: undefined,
				status: 'pending',
			})
			return { ...state, agents: newAgents }
		}

		// ---- Mailbox ----

		case 'mailbox_message': {
			const msg = event.message
			const entry: MailboxEntry = {
				id: msg.id,
				from: msg.from,
				content: msg.content,
				timestamp: msg.timestamp,
				consumed: msg.consumed,
			}

			const existing = state.agentMailboxes.get(event.toAgentId) ?? []
			const newMailboxes = new Map(state.agentMailboxes)
			newMailboxes.set(event.toAgentId, [...existing, entry])

			// Increment sender's messagesSentCount if sender is an agent
			const senderAgentId = typeof msg.from === 'string' && msg.from !== 'user'
					&& msg.from !== 'orchestrator' && msg.from !== 'communicator'
				? msg.from
				: null

			if (senderAgentId) {
				const senderCounters = state.agentCounters.get(senderAgentId as AgentId)
				if (senderCounters) {
					const newCounters = new Map(state.agentCounters)
					newCounters.set(senderAgentId as AgentId, {
						...senderCounters,
						messagesSentCount: senderCounters.messagesSentCount + 1,
					})
					return { ...state, agentMailboxes: newMailboxes, agentCounters: newCounters }
				}
			}

			return { ...state, agentMailboxes: newMailboxes }
		}

		case 'mailbox_consumed': {
			const existing = state.agentMailboxes.get(event.agentId)
			if (!existing) return state

			const consumedSet = new Set(event.messageIds as string[])
			const updated = existing.map((m) => consumedSet.has(m.id) ? { ...m, consumed: true } : m)
			const newMailboxes = new Map(state.agentMailboxes)
			newMailboxes.set(event.agentId, updated)
			return { ...state, agentMailboxes: newMailboxes }
		}

		// ---- Skills ----

		case 'skill_loaded': {
			const agentSkills = state.agentSkills.get(event.agentId) ?? []
			const newSkills = new Map(state.agentSkills)
			newSkills.set(event.agentId, [...agentSkills, {
				id: event.skillId,
				name: event.skillName,
				loadedAt: event.timestamp,
			}])
			return { ...state, agentSkills: newSkills }
		}

		default:
			return state
	}
}

// ============================================================================
// Query
// ============================================================================

const truncate = (text: string): string => text.length > 500 ? text.slice(0, 500) + '...' : text

/**
 * Get agent detail response from projection state.
 */
export function getAgentDetail(state: AgentDetailProjectionState, agentId: AgentId): GetAgentDetailResponse | null {
	const agent = state.agents.get(agentId)
	if (!agent) return null

	// Mailbox
	const agentMailbox = state.agentMailboxes.get(agentId) ?? []
	const mailbox: MailboxMessageView[] = agentMailbox.map((m) => ({
		id: m.id,
		from: m.from,
		content: m.content,
		timestamp: m.timestamp,
		consumed: m.consumed,
	}))

	// Conversation history
	const conversationHistory: ConversationMessageView[] = agent.conversationHistory.map((m) => {
		switch (m.role) {
			case 'user': {
				const full = contentToString(m.content)
				return { role: 'user' as const, content: truncate(full), fullContent: full, timestamp: m.timestamp }
			}
			case 'assistant': {
				const full = contentToString(m.content)
				return {
					role: 'assistant' as const,
					content: truncate(full),
					fullContent: full,
					toolCalls: m.toolCalls?.map((tc) => ({
						id: tc.id,
						name: tc.name,
						input: tc.input,
					})),
					timestamp: m.timestamp,
					cost: m.cost,
					llmCallId: m.llmCallId,
					promptTokens: m.promptTokens,
					cachedTokens: m.cachedTokens,
					cacheWriteTokens: m.cacheWriteTokens,
				}
			}
			case 'tool': {
				const full = contentToString(m.content)
				return {
					role: 'tool' as const,
					toolCallId: m.toolCallId!,
					content: truncate(full),
					fullContent: full,
					isError: m.isError ?? false,
					timestamp: m.timestamp,
				}
			}
			case 'system': {
				const full = contentToString(m.content)
				return { role: 'system' as const, content: truncate(full), fullContent: full, timestamp: m.timestamp }
			}
		}
	})

	// Pending tool calls
	const pendingToolCalls: ToolCallView[] = [
		...agent.pendingToolCalls.map(
			(tc): ToolCallView => ({
				id: tc.id,
				name: tc.name,
				input: tc.input,
				status: 'pending' as const,
			}),
		),
		...(agent.executingToolCall
			? [
				{
					id: agent.executingToolCall.toolCallId,
					name: agent.executingToolCall.toolName,
					input: undefined,
					status: 'executing' as const,
				} satisfies ToolCallView,
			]
			: []),
		...agent.pendingToolResults.map(
			(pr): ToolCallView => ({
				id: pr.toolCallId,
				name: pr.toolName,
				input: undefined,
				status: pr.isError ? 'failed' as const : 'completed' as const,
				result: pr.isError ? undefined : contentToString(pr.content),
				error: pr.isError ? contentToString(pr.content) : undefined,
			}),
		),
	]

	// Counters
	const counters = state.agentCounters.get(agentId) ?? createDefaultCounters()

	// Skills
	const loadedSkills = state.agentSkills.get(agentId) ?? []

	return {
		id: agent.id,
		definitionName: agent.definitionName,
		status: toProtocolStatus(agent.status),
		parentId: agent.parentId,
		mailbox,
		conversationHistory,
		pendingToolCalls,
		counters,
		loadedSkills,
		cost: agent.cost,
		typedInput: agent.typedInput,
		pauseReason: agent.pauseReason,
		pauseMessage: agent.pauseMessage,
	}
}
