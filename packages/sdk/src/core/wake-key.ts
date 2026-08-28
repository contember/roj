/**
 * Routing keys for scheduler wakes.
 *
 * A wake must be dispatchable after the process that armed it is gone, so it
 * carries no closure: the key is the whole routing table. `SessionManager`
 * mints and reads them, and `dispatchWake` turns one back into a session.
 *
 * Their own module because both the agent loop and the plugins that arm wakes
 * need them, and neither should have to import the other to mint one.
 */

import { AgentId } from '~/core/agents/schema.js'
import { isValidSessionId, SessionId } from '~/core/sessions/schema.js'

/** Which delayed re-entry an agent wake stands for. */
export type AgentWakeKind = 'debounce' | 'retry'

export interface AgentWake {
	sessionId: SessionId
	agentId: AgentId
	kind: AgentWakeKind
}

export interface PluginWake {
	sessionId: SessionId
	pluginName: string
	method: string
	agentId: AgentId | undefined
}

/** `agent:<sessionId>:<agentId>:<kind>` */
export function agentWakeKey(sessionId: SessionId, agentId: AgentId, kind: AgentWakeKind): string {
	return `agent:${sessionId}:${agentId}:${kind}`
}

/** Read a key back, or null when it is not one `agentWakeKey` minted. */
export function parseAgentWakeKey(key: string): AgentWake | null {
	const parts = key.split(':')
	if (parts.length !== 4 || parts[0] !== 'agent') return null
	const [, sessionId, agentId, kind] = parts
	if (kind !== 'debounce' && kind !== 'retry') return null
	if (agentId === '' || !isValidSessionId(sessionId)) return null
	return { sessionId: SessionId(sessionId), agentId: AgentId(agentId), kind }
}

/** `plugin:<sessionId>:<pluginName>:<method>[:<agentId>]` */
export function pluginWakeKey(sessionId: SessionId, pluginName: string, method: string, agentId?: AgentId): string {
	const base = `plugin:${sessionId}:${pluginName}:${method}`
	return agentId === undefined ? base : `${base}:${agentId}`
}

/** Read a key back, or null when it is not one `pluginWakeKey` minted. */
export function parsePluginWakeKey(key: string): PluginWake | null {
	const parts = key.split(':')
	if (parts.length !== 4 && parts.length !== 5) return null
	const [prefix, sessionId, pluginName, method, agentId] = parts
	if (prefix !== 'plugin' || pluginName === '' || method === '') return null
	if (agentId === '' || !isValidSessionId(sessionId)) return null
	return {
		sessionId: SessionId(sessionId),
		pluginName,
		method,
		agentId: agentId === undefined ? undefined : AgentId(agentId),
	}
}
