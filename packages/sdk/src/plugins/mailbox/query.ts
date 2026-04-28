/**
 * Mailbox plugin query helpers.
 *
 * Query functions accept MailboxPluginState directly.
 * Use selectMailboxState() to extract plugin state from SessionState.
 */

import type { AgentId } from '~/core/agents/schema.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import type { SessionState } from '~/core/sessions/state.js'
import type { MailboxMessage } from './schema.js'

/**
 * Mailbox plugin state — session-level state keyed by agent ID.
 */
export interface MailboxPluginState {
	agentMailboxes: Map<AgentId, MailboxMessage[]>
}

const defaultState: MailboxPluginState = { agentMailboxes: new Map() }

/**
 * Extract MailboxPluginState from SessionState.
 */
export function selectMailboxState(sessionState: SessionState): MailboxPluginState {
	return selectPluginState<MailboxPluginState>(sessionState, 'mailbox') ?? defaultState
}

/**
 * Get all mailbox messages for a specific agent.
 */
export function getAgentMailbox(pluginState: MailboxPluginState, agentId: AgentId): MailboxMessage[] {
	return pluginState.agentMailboxes.get(agentId) ?? []
}

/**
 * Get unconsumed mailbox messages for a specific agent.
 */
export function getAgentUnconsumedMailbox(pluginState: MailboxPluginState, agentId: AgentId): MailboxMessage[] {
	return getAgentMailbox(pluginState, agentId).filter((m) => !m.consumed)
}

/**
 * Get the next message sequence number.
 * Derived from total message count across all mailboxes (replay-safe).
 */
export function getNextMessageSeq(pluginState: MailboxPluginState): number {
	let total = 0
	for (const messages of pluginState.agentMailboxes.values()) {
		total += messages.length
	}
	return total + 1
}
