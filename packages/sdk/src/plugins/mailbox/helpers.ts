import { AgentId } from '~/core/agents'
import { COMMUNICATOR_ROLE, ORCHESTRATOR_ROLE } from '~/core/agents/agent-roles'
import { AgentState } from '~/core/agents/state'

/**
 * Check if an agent can communicate with another agent.
 * Communication is only allowed with:
 * - Parent agent
 * - Child agents
 * - Special case: communicator ↔ orchestrator (both are root-level)
 */
export const canCommunicateWith = (
	session: { agents: Map<AgentId, AgentState> },
	fromAgentId: AgentId,
	toAgentId: AgentId,
): boolean => {
	const fromAgent = session.agents.get(fromAgentId)
	const toAgent = session.agents.get(toAgentId)

	if (!fromAgent || !toAgent) return false

	// Can communicate with parent
	if (fromAgent.parentId === toAgentId) return true

	// Can communicate with child
	if (toAgent.parentId === fromAgentId) return true

	// Special case: communicator ↔ orchestrator (both are root-level agents)
	if (fromAgent.parentId === null && toAgent.parentId === null) {
		const fromDef = fromAgent.definitionName
		const toDef = toAgent.definitionName
		if (
			(fromDef === COMMUNICATOR_ROLE && toDef === ORCHESTRATOR_ROLE)
			|| (fromDef === ORCHESTRATOR_ROLE && toDef === COMMUNICATOR_ROLE)
		) {
			return true
		}
	}

	return false
}

/**
 * Get list of agents that the given agent can communicate with.
 * Returns parent (if exists), children, and communicator/orchestrator peer (if applicable).
 */
export const getCommunicableAgents = (
	session: { agents: Map<AgentId, AgentState> },
	agentId: AgentId,
): AgentId[] => {
	const agent = session.agents.get(agentId)
	if (!agent) return []

	const result: AgentId[] = []

	// Parent
	if (agent.parentId) {
		result.push(agent.parentId)
	}

	// Children
	for (const [id, other] of session.agents) {
		if (other.parentId === agentId) {
			result.push(id)
		}
	}

	// Special case: communicator ↔ orchestrator
	if (agent.parentId === null) {
		for (const [id, other] of session.agents) {
			if (id === agentId) continue
			if (other.parentId === null) {
				const isCommOrch = (agent.definitionName === COMMUNICATOR_ROLE && other.definitionName === ORCHESTRATOR_ROLE)
					|| (agent.definitionName === ORCHESTRATOR_ROLE && other.definitionName === COMMUNICATOR_ROLE)
				if (isCommOrch) {
					result.push(id)
				}
			}
		}
	}

	return result
}
