import type { DomainEvent, FactoryEventType } from '~/core/events/types.js'
import type { SessionId } from '~/core/sessions/schema.js'
import type { toolEvents } from '~/core/tools/state.js'
import type { SessionCreatedEvent } from './state.js'
import { isSessionCreatedEvent } from './state.js'

/**
 * Rewrite events for a fork: slice to eventIndex (inclusive), rewrite sessionId,
 * and add forkedFrom to the session_created event.
 */
export function rewriteEventsForFork(
	sourceEvents: DomainEvent[],
	eventIndex: number,
	newSessionId: SessionId,
	sourceSessionId: SessionId,
): DomainEvent[] {
	const sliced = sourceEvents.slice(0, eventIndex + 1)

	return sliced.map((event) => {
		if (isSessionCreatedEvent(event)) {
			return {
				...event,
				sessionId: newSessionId,
				forkedFrom: { sessionId: sourceSessionId, eventIndex },
			} satisfies SessionCreatedEvent
		}
		return { ...event, sessionId: newSessionId }
	})
}

/**
 * Snapshot refs found at a given event index.
 */
export interface SnapshotRefsAtIndex {
	sessionRef?: string
	workspaceRef?: string
}

type SnapshotRefEvent = FactoryEventType<typeof toolEvents>

/**
 * Scan backwards from eventIndex to find the most recent sessionRef and workspaceRef
 * from tool_completed or tool_failed events.
 */
export function findSnapshotRefsAtIndex(
	events: DomainEvent[],
	eventIndex: number,
): SnapshotRefsAtIndex {
	let sessionRef: string | undefined
	let workspaceRef: string | undefined

	for (let i = eventIndex; i >= 0; i--) {
		const event = events[i] as SnapshotRefEvent

		if (
			event.type === 'tool_completed'
			|| event.type === 'tool_failed'
		) {
			if (!sessionRef && event.sessionRef) {
				sessionRef = event.sessionRef
			}
			if (!workspaceRef && event.workspaceRef) {
				workspaceRef = event.workspaceRef
			}

			if (sessionRef && workspaceRef) break
		}
	}

	return { sessionRef, workspaceRef }
}
