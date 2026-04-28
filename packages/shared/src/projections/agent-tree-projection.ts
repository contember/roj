/**
 * Agent tree projection - self-contained projection for building agent tree.
 *
 * Replaces the old buildAgentTree() that needed full SessionState.
 * Tracks per-agent: status, parent, pending tool call count, executing flag, mailbox counts.
 */

import type { AgentId } from '@roj-ai/sdk'
import type { ProjectionEvent } from './events.js'
import { toProtocolStatus } from './protocol-status.js'
import type { AgentTreeNode } from './types.js'

// ============================================================================
// State
// ============================================================================

interface AgentTreeEntry {
	id: AgentId
	definitionName: string
	status: 'pending' | 'inferring' | 'tool_exec' | 'errored' | 'paused'
	parentId: AgentId | null
	pendingToolCallCount: number
	isExecuting: boolean
	mailboxUnconsumedCount: number
	cost: number
}

export interface AgentTreeProjectionState {
	agents: Map<AgentId, AgentTreeEntry>
}

export function createAgentTreeProjectionState(): AgentTreeProjectionState {
	return { agents: new Map() }
}

// ============================================================================
// Reducer
// ============================================================================

export function applyEventToAgentTree(state: AgentTreeProjectionState, event: ProjectionEvent): AgentTreeProjectionState {
	switch (event.type) {
		case 'agent_spawned': {
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, {
				id: event.agentId,
				definitionName: event.definitionName,
				status: 'pending',
				parentId: event.parentId,
				pendingToolCallCount: 0,
				isExecuting: false,
				mailboxUnconsumedCount: 0,
				cost: 0,
			})
			return { ...state, agents: newAgents }
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
			newAgents.set(event.agentId, { ...agent, status: 'inferring' })
			return { ...state, agents: newAgents }
		}

		case 'inference_completed': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const toolCallCount = event.response.toolCalls.length
			const newAgents = new Map(state.agents)

			// Decrement mailbox unconsumed count for consumed messages
			let agents = newAgents
			if (event.consumedMessageIds.length > 0) {
				agents = decrementMailboxCounts(agents, event.agentId, event.consumedMessageIds.length)
			}

			agents.set(event.agentId, {
				...agent,
				status: toolCallCount > 0 ? 'tool_exec' : 'pending',
				pendingToolCallCount: toolCallCount,
				isExecuting: false,
				cost: agent.cost + (event.metrics.cost ?? 0),
			})

			return { ...state, agents }
		}

		case 'inference_failed': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, { ...agent, status: 'errored' })
			return { ...state, agents: newAgents }
		}

		case 'tool_started': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, { ...agent, isExecuting: true })
			return { ...state, agents: newAgents }
		}

		case 'tool_completed':
		case 'tool_failed': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const remaining = Math.max(0, agent.pendingToolCallCount - 1)
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, {
				...agent,
				pendingToolCallCount: remaining,
				isExecuting: false,
				status: remaining === 0 ? 'pending' : 'tool_exec',
			})
			return { ...state, agents: newAgents }
		}

		case 'agent_paused': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, { ...agent, status: 'paused' })
			return { ...state, agents: newAgents }
		}

		case 'agent_resumed': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			const newAgents = new Map(state.agents)
			newAgents.set(event.agentId, { ...agent, status: 'pending' })
			return { ...state, agents: newAgents }
		}

		case 'session_restarted': {
			const newAgents = new Map(state.agents)
			for (const [agentId, agent] of state.agents) {
				let updated = agent
				let changed = false

				if (agent.status === 'inferring') {
					updated = { ...updated, status: 'pending' as const }
					changed = true
				}
				if (agent.isExecuting) {
					updated = { ...updated, isExecuting: false }
					changed = true
				}

				if (changed) {
					newAgents.set(agentId, updated)
				}
			}
			return { ...state, agents: newAgents }
		}

		case 'mailbox_message': {
			const agent = state.agents.get(event.toAgentId)
			if (!agent) return state
			const newAgents = new Map(state.agents)
			newAgents.set(event.toAgentId, {
				...agent,
				mailboxUnconsumedCount: agent.mailboxUnconsumedCount + 1,
			})
			return { ...state, agents: newAgents }
		}

		case 'mailbox_consumed': {
			const agent = state.agents.get(event.agentId)
			if (!agent) return state
			return {
				...state,
				agents: decrementMailboxCounts(new Map(state.agents), event.agentId, event.messageIds.length),
			}
		}

		default:
			return state
	}
}

function decrementMailboxCounts(agents: Map<AgentId, AgentTreeEntry>, agentId: AgentId, count: number): Map<AgentId, AgentTreeEntry> {
	const agent = agents.get(agentId)
	if (!agent) return agents
	agents.set(agentId, {
		...agent,
		mailboxUnconsumedCount: Math.max(0, agent.mailboxUnconsumedCount - count),
	})
	return agents
}

// ============================================================================
// Query
// ============================================================================

/**
 * Build agent tree nodes from projection state.
 */
export function buildAgentTreeFromProjection(state: AgentTreeProjectionState): AgentTreeNode[] {
	const allAgents = Array.from(state.agents.values())
	const rootAgents = allAgents.filter((a) => a.parentId === null)
	return rootAgents.map((agent) => buildTreeNode(state, agent))
}

function buildTreeNode(state: AgentTreeProjectionState, agent: AgentTreeEntry): AgentTreeNode {
	const children = Array.from(state.agents.values())
		.filter((a) => a.parentId === agent.id)
		.map((child) => buildTreeNode(state, child))

	return {
		id: agent.id,
		definitionName: agent.definitionName,
		status: toProtocolStatus(agent.status),
		parentId: agent.parentId,
		children,
		mailboxCount: agent.mailboxUnconsumedCount,
		pendingToolCalls: agent.pendingToolCallCount,
		isExecuting: agent.isExecuting,
		cost: agent.cost,
	}
}
