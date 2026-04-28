/**
 * Global mailbox projection - tracks all inter-agent messages.
 */

import type { AgentId } from '@roj-ai/sdk'
import type { AgentRegistryState } from './agent-registry.js'
import type { ProjectionEvent } from './events.js'
import type { GlobalMailboxMessage } from './types.js'

export interface MailboxState {
	messages: GlobalMailboxMessage[]
	consumedIds: Set<string>
}

export function createMailboxState(): MailboxState {
	return {
		messages: [],
		consumedIds: new Set(),
	}
}

/**
 * Apply event to mailbox state.
 * @param registry Agent registry for name lookups
 */
export function applyEventToMailbox(
	state: MailboxState,
	event: ProjectionEvent,
	registry: AgentRegistryState,
): MailboxState {
	switch (event.type) {
		case 'mailbox_message': {
			const msg = event.message

			// Determine from agent name
			let fromAgentId: string
			let fromAgentName: string

			if (msg.from === 'user') {
				fromAgentId = 'user'
				fromAgentName = 'User'
			} else if (msg.from === 'orchestrator' || msg.from === 'communicator') {
				fromAgentId = msg.from
				fromAgentName = msg.from.charAt(0).toUpperCase() + msg.from.slice(1)
			} else {
				fromAgentId = msg.from
				fromAgentName = registry.names.get(msg.from as AgentId) ?? 'unknown'
			}

			const newMessage: GlobalMailboxMessage = {
				id: msg.id,
				fromAgentId,
				fromAgentName,
				toAgentId: event.toAgentId,
				toAgentName: registry.names.get(event.toAgentId) ?? 'unknown',
				content: msg.content,
				timestamp: msg.timestamp,
				consumed: state.consumedIds.has(msg.id),
			}

			return {
				...state,
				messages: [...state.messages, newMessage],
			}
		}

		case 'mailbox_consumed': {
			const newConsumedIds = new Set(state.consumedIds)
			for (const msgId of event.messageIds) {
				newConsumedIds.add(msgId)
			}

			// Update consumed status in existing messages
			const consumedSet = new Set(event.messageIds as string[])
			const updatedMessages = state.messages.map((m) => consumedSet.has(m.id) ? { ...m, consumed: true } : m)

			return {
				messages: updatedMessages,
				consumedIds: newConsumedIds,
			}
		}

		case 'inference_completed': {
			// inference_completed also marks messages as consumed
			if (event.consumedMessageIds.length === 0) return state

			const newConsumedIds = new Set(state.consumedIds)
			for (const msgId of event.consumedMessageIds) {
				newConsumedIds.add(msgId)
			}

			// Update consumed status in existing messages
			const consumedSet = new Set(event.consumedMessageIds as string[])
			const updatedMessages = state.messages.map((m) => consumedSet.has(m.id) ? { ...m, consumed: true } : m)

			return {
				messages: updatedMessages,
				consumedIds: newConsumedIds,
			}
		}

		default:
			return state
	}
}

/**
 * Get mailbox messages sorted by timestamp.
 */
export function getMailboxMessages(state: MailboxState): GlobalMailboxMessage[] {
	// Messages are already in order since we append them
	return state.messages
}
