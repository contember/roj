import type { DomainEvent } from '~/core/events/types.js'
import type { SessionId, SessionMetadata } from '~/core/sessions/schema.js'
import { BaseEventStore } from './base-event-store.js'
import type { LoadRangeOptions, LoadRangeResult } from './event-store.js'

/**
 * MemoryEventStore - In-memory event store for testing.
 *
 * Provides simple in-memory storage with test helpers for inspecting events.
 */
export class MemoryEventStore extends BaseEventStore {
	private events = new Map<SessionId, DomainEvent[]>()
	private metadata = new Map<SessionId, SessionMetadata>()

	protected async doAppend(sessionId: SessionId, event: DomainEvent): Promise<void> {
		const existing = this.events.get(sessionId) ?? []
		this.events.set(sessionId, [...existing, event])
		await this.updateMetadataFromEvents(sessionId, [event])
	}

	protected async doAppendBatch(sessionId: SessionId, events: DomainEvent[]): Promise<void> {
		if (events.length === 0) return

		const existing = this.events.get(sessionId) ?? []
		this.events.set(sessionId, [...existing, ...events])
		await this.updateMetadataFromEvents(sessionId, events)
	}

	async load(sessionId: SessionId): Promise<DomainEvent[]> {
		return this.events.get(sessionId) ?? []
	}

	async exists(sessionId: SessionId): Promise<boolean> {
		return this.events.has(sessionId)
	}

	async listSessions(): Promise<SessionId[]> {
		return Array.from(this.events.keys())
	}

	async loadRange(
		sessionId: SessionId,
		options?: LoadRangeOptions,
	): Promise<LoadRangeResult> {
		const allEvents = this.events.get(sessionId) ?? []
		const since = options?.since ?? -1
		const limit = options?.limit

		// toIndex always reflects the actual last event in the store (for polling cursor)
		const storeLastIndex = allEvents.length - 1

		const fromIndex = since + 1
		if (fromIndex >= allEvents.length) {
			// No new events, but return the actual last index so client can continue polling
			return { events: [], fromIndex: -1, toIndex: storeLastIndex }
		}

		const endIndex = limit !== undefined
			? Math.min(fromIndex + limit, allEvents.length)
			: allEvents.length

		const events = allEvents.slice(fromIndex, endIndex)

		return {
			events,
			fromIndex: events.length > 0 ? fromIndex : -1,
			toIndex: endIndex - 1,
		}
	}

	// =========================================================================
	// Metadata storage primitives
	// =========================================================================

	protected async readMetadata(sessionId: SessionId): Promise<SessionMetadata | null> {
		return this.metadata.get(sessionId) ?? null
	}

	protected async writeMetadata(sessionId: SessionId, metadata: SessionMetadata): Promise<void> {
		this.metadata.set(sessionId, metadata)
	}

	protected async getAllSessionMetadata(): Promise<SessionMetadata[]> {
		return Array.from(this.metadata.values())
	}

	// =========================================================================
	// Test helpers
	// =========================================================================

	/**
	 * Clears all events and metadata.
	 */
	clear(): void {
		this.events.clear()
		this.metadata.clear()
	}

	/**
	 * Returns all events for inspection in tests.
	 */
	getAll(): Map<SessionId, DomainEvent[]> {
		return new Map(this.events)
	}

	/**
	 * Returns event count for a session.
	 */
	getEventCount(sessionId: SessionId): number {
		return this.events.get(sessionId)?.length ?? 0
	}

	/**
	 * Returns the last event for a session.
	 */
	getLastEvent(sessionId: SessionId): DomainEvent | undefined {
		const events = this.events.get(sessionId)
		return events?.[events.length - 1]
	}

	/**
	 * Returns events of a given type.
	 */
	getEventsByType(
		sessionId: SessionId,
		type: string,
	): DomainEvent[] {
		const events = this.events.get(sessionId) ?? []
		return events.filter((e) => e.type === type)
	}
}
