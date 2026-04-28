/**
 * Agent role constants.
 *
 * These constants define the special agent roles in the system:
 * - ORCHESTRATOR: The main agent that coordinates work and spawns sub-agents
 * - COMMUNICATOR: Optional agent that handles user communication in communication-agent mode
 */

/** Orchestrator agent role - the main coordinating agent */
export const ORCHESTRATOR_ROLE = 'orchestrator' as const

/** Communicator agent role - handles user communication */
export const COMMUNICATOR_ROLE = 'communicator' as const

/** Type for special agent roles */
export type AgentRole = typeof ORCHESTRATOR_ROLE | typeof COMMUNICATOR_ROLE

/**
 * Prompt-level role classification for system prompt composition.
 * - 'entry': Orchestrator without communicator (talks to user directly)
 * - 'orchestrator': Orchestrator with communicator (talks to communicator, not user)
 * - 'child': Spawned by parent, reports results back
 * - 'communicator': Handles user communication, relays to orchestrator
 */
export type PromptRole = 'entry' | 'orchestrator' | 'child' | 'communicator'

/**
 * Determine an agent's prompt role from its state and session context.
 */
export function getAgentRole(
	agentState: { definitionName: string; parentId: string | null },
	sessionState: { agents: Map<string, { definitionName: string }> },
): PromptRole {
	if (agentState.definitionName === COMMUNICATOR_ROLE) return 'communicator'
	const hasCommunicator = Array.from(sessionState.agents.values())
		.some(a => a.definitionName === COMMUNICATOR_ROLE)
	if (agentState.definitionName === ORCHESTRATOR_ROLE) {
		return hasCommunicator ? 'orchestrator' : 'entry'
	}
	return 'child'
}
