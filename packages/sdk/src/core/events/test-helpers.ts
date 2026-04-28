/**
 * Helpers for creating branded DomainEvent objects.
 *
 * Event factories (sessionEvents, agentEvents, etc.) produce events
 * without `sessionId` (it's added by `emitEvent()` at runtime).
 * `withSessionId` adds the missing field and returns a full DomainEvent.
 *
 * Usage:
 *   const event = withSessionId(sessionId, sessionEvents.create('session_created', { presetId: 'test' }))
 */
import type { BaseEvent } from '~/core/events/types.js'
import type { DomainEvent } from '~/core/events/types.js'
import type { SessionId } from '~/core/sessions/schema.js'

/**
 * Add `sessionId` to a factory-created event, producing a full DomainEvent.
 *
 * The factory `.create()` returns `Omit<BaseEvent<K>, 'sessionId'> & payload`
 * (branded but missing sessionId). This function adds the missing field.
 *
 * TypeScript cannot prove `Omit<Union, 'key'> & { key }` reconstructs the
 * original union (Omit destroys discriminants). The return type uses the same
 * brand-bridging pattern as `createEventsFactory` — safe because all factory
 * events with sessionId are structurally valid DomainEvent members.
 */
export function withSessionId<T extends Omit<BaseEvent<string>, 'sessionId'>>(
	sessionId: SessionId,
	event: T,
): T & { sessionId: SessionId } & DomainEvent {
	return Object.assign(event, { sessionId }) as T & { sessionId: SessionId } & DomainEvent
}
