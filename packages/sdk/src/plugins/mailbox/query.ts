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
	/** Highest message sequence observed, including consumed messages. */
	messageSequence?: number
}

const defaultState: MailboxPluginState = { agentMailboxes: new Map(), messageSequence: 0 }

/**
 * Extract MailboxPluginState from SessionState.
 */
export function selectMailboxState(sessionState: SessionState): MailboxPluginState {
	return selectPluginState<MailboxPluginState>(sessionState, 'mailbox') ?? defaultState
}

/**
 * Get pending mailbox messages for a specific agent.
 *
 * Consumed messages are removed from live state and remain available only in
 * the event log.
 */
export function getAgentMailbox(pluginState: MailboxPluginState, agentId: AgentId): MailboxMessage[] {
	return pluginState.agentMailboxes.get(agentId) ?? []
}

/**
 * Get unconsumed mailbox messages for a specific agent.
 */
export function getAgentUnconsumedMailbox(pluginState: MailboxPluginState, agentId: AgentId): MailboxMessage[] {
	return getAgentMailbox(pluginState, agentId)
}

/**
 * Get the next message sequence number.
 * Uses the persistent high-water mark so pruning cannot reuse IDs.
 */
export function getNextMessageSeq(pluginState: MailboxPluginState): number {
	let highest = pluginState.messageSequence ?? 0
	for (const messages of pluginState.agentMailboxes.values()) {
		for (const message of messages) {
			const match = /^m(\d+)$/.exec(message.id)
			if (match) highest = Math.max(highest, Number(match[1]))
		}
	}
	return highest + 1
}
