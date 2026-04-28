/**
 * Agent registry projection - tracks agent names and count.
 *
 * Minimal projection that replaces SessionState for name lookups.
 * Handles only agent_spawned events.
 */

import type { AgentId } from '@roj-ai/sdk'
import type { ProjectionEvent } from './events.js'

export interface AgentRegistryState {
	names: Map<AgentId, string>
	count: number
}

export function createAgentRegistryState(): AgentRegistryState {
	return {
		names: new Map(),
		count: 0,
	}
}

export function applyEventToAgentRegistry(state: AgentRegistryState, event: ProjectionEvent): AgentRegistryState {
	if (event.type !== 'agent_spawned') return state

	const newNames = new Map(state.names)
	newNames.set(event.agentId, event.definitionName)

	return {
		names: newNames,
		count: state.count + 1,
	}
}

export function getAgentName(state: AgentRegistryState, agentId: AgentId | string): string {
	return state.names.get(agentId as AgentId) ?? 'unknown'
}
