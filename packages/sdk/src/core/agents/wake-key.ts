/**
 * Scheduler wake keys for the agent loop.
 *
 * A wake is delivered by whichever process happens to be alive when it comes
 * due — on Cloudflare that is a fresh isolate with nothing in memory. So the key
 * carries everything needed to route it, and routing is a pure function of the
 * key plus a session loaded by id.
 */

import type { SessionId } from '~/core/sessions/schema.js'
import { SessionId as toSessionId } from '~/core/sessions/schema.js'
import type { AgentId } from './schema.js'
import { AgentId as toAgentId } from './schema.js'

/** What a due agent wake means. */
export type AgentWakeKind = 'debounce' | 'retry'

/** Namespace prefix, so other subsystems can mint keys without colliding. */
const AGENT_NAMESPACE = 'agent'

export interface AgentWake {
	sessionId: SessionId
	agentId: AgentId
	kind: AgentWakeKind
}

export function agentWakeKey(sessionId: SessionId, agentId: AgentId, kind: AgentWakeKind): string {
	return `${AGENT_NAMESPACE}:${sessionId}:${agentId}:${kind}`
}

/**
 * `undefined` for anything this module did not mint — callers read that as
 * "not an agent wake", never as an error.
 */
export function parseAgentWakeKey(key: string): AgentWake | undefined {
	const parts = key.split(':')
	if (parts.length !== 4) return undefined
	const [namespace, sessionId, agentId, kind] = parts
	if (namespace !== AGENT_NAMESPACE) return undefined
	if (kind !== 'debounce' && kind !== 'retry') return undefined
	if (!sessionId || !agentId) return undefined
	return { sessionId: toSessionId(sessionId), agentId: toAgentId(agentId), kind }
}
