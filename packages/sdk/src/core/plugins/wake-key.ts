/**
 * Scheduler wake keys for plugin-owned timers.
 *
 * Same rule as agent wakes (see `~/core/agents/wake-key.ts`): the isolate that
 * armed one may be gone when it comes due, so the key carries the whole routing
 * table. Here that is a plugin method — already reachable by name on a session
 * loaded from its event log, already given a fresh context per call — plus the
 * agent the wake is about, if any.
 *
 * No segment may contain `:`; a key built from one would never parse back.
 */

import type { AgentId } from '~/core/agents/schema.js'
import { AgentId as toAgentId } from '~/core/agents/schema.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { SessionId as toSessionId } from '~/core/sessions/schema.js'

/** Namespace prefix, so other subsystems can mint keys without colliding. */
const PLUGIN_NAMESPACE = 'plugin'

export interface PluginWake {
	sessionId: SessionId
	pluginName: string
	method: string
	/** Present when the wake is about one agent — the method is called with `{ agentId }`. */
	agentId?: AgentId
}

export function pluginWakeKey(sessionId: SessionId, pluginName: string, method: string, agentId?: AgentId): string {
	const base = `${PLUGIN_NAMESPACE}:${sessionId}:${pluginName}:${method}`
	return agentId === undefined ? base : `${base}:${agentId}`
}

/**
 * `undefined` for anything this module did not mint — callers read that as
 * "not a plugin wake", never as an error.
 */
export function parsePluginWakeKey(key: string): PluginWake | undefined {
	const parts = key.split(':')
	if (parts.length !== 4 && parts.length !== 5) return undefined
	const [namespace, sessionId, pluginName, method, agentId] = parts
	if (namespace !== PLUGIN_NAMESPACE) return undefined
	if (!sessionId || !pluginName || !method) return undefined
	if (parts.length === 5 && !agentId) return undefined
	return {
		sessionId: toSessionId(sessionId),
		pluginName,
		method,
		...(agentId ? { agentId: toAgentId(agentId) } : {}),
	}
}
