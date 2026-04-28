import type { DomainEvent } from '~/core/events/types.js'
import type { ListSessionsOptions, SessionId, SessionMetadata } from '~/core/sessions/schema.js'

export type { ListSessionsOptions, SessionMetadata }

/**
 * Options for loading a range of events.
 */
export interface LoadRangeOptions {
	/** Skip events with index <= since (0-indexed). Default: -1 (load from start) */
	since?: number
	/** Max events to return. Default: no limit */
	limit?: number
}

/**
 * Result of loading a range of events.
 */
export interface LoadRangeResult {
	events: DomainEvent[]
	/** Index of first returned event (-1 if no events returned) */
	fromIndex: number
	/** Index of last event in the store, used as cursor for polling (-1 only if store is empty) */
	toIndex: number
}

/**
 * EventStore interface pro persistenci domain events.
 *
 * Implementace:
 * - FileEventStore - JSONL soubory (production)
 * - MemoryEventStore - in-memory (testy)
 */
export interface EventStore {
	/**
	 * Přidá jeden event do store.
	 */
	append(sessionId: SessionId, event: DomainEvent): Promise<void>

	/**
	 * Přidá více eventů atomicky.
	 * Všechny eventy musí být uloženy, nebo žádný.
	 */
	appendBatch(sessionId: SessionId, events: DomainEvent[]): Promise<void>

	/**
	 * Načte všechny eventy pro session.
	 * Eventy jsou vráceny v pořadí jak byly uloženy.
	 */
	load(sessionId: SessionId): Promise<DomainEvent[]>

	/**
	 * Zkontroluje zda session existuje.
	 */
	exists(sessionId: SessionId): Promise<boolean>

	/**
	 * Vrátí seznam všech session IDs.
	 * Použito při restartu pro načtení všech sessions.
	 */
	listSessions(): Promise<SessionId[]>

	/**
	 * Načte metadata session.
	 * Vrátí null pokud session neexistuje nebo nemá metadata.
	 */
	getMetadata(sessionId: SessionId): Promise<SessionMetadata | null>

	/**
	 * Aktualizuje metadata session.
	 * Merge s existujícími hodnotami.
	 */
	updateMetadata(
		sessionId: SessionId,
		update: Partial<SessionMetadata>,
	): Promise<void>

	/**
	 * Vrátí seznam sessions s metadata.
	 * Podporuje filtrování, řazení a paginaci.
	 */
	listSessionsWithMetadata(
		options?: ListSessionsOptions,
	): Promise<{ sessions: SessionMetadata[]; total: number }>

	/**
	 * Načte rozsah eventů pro session.
	 * Optimalizováno pro polling - čte z konce souboru pokud je to efektivní.
	 */
	loadRange(
		sessionId: SessionId,
		options?: LoadRangeOptions,
	): Promise<LoadRangeResult>

	/**
	 * Validates and reconciles metadata against actual events.
	 * If metadata is out of sync (e.g., after crash), recomputes it from events.
	 * Returns true if metadata was reconciled (was out of sync).
	 */
	reconcileMetadata(
		sessionId: SessionId,
		events: DomainEvent[],
	): Promise<boolean>
}

/**
 * EventStore s podporou pro streaming (optional rozšíření).
 */
export interface StreamingEventStore extends EventStore {
	/**
	 * Streamuje eventy pro session.
	 * Užitečné pro velké sessions.
	 */
	stream(sessionId: SessionId): AsyncIterable<DomainEvent>
}

/**
 * Error types pro EventStore
 */
export class EventStoreError extends Error {
	constructor(
		message: string,
		public readonly sessionId: SessionId,
		public readonly cause?: unknown,
	) {
		super(message)
		this.name = 'EventStoreError'
	}
}

export class SessionNotFoundError extends EventStoreError {
	constructor(sessionId: SessionId) {
		super(`Session not found: ${sessionId}`, sessionId)
		this.name = 'SessionNotFoundError'
	}
}

export class EventAppendError extends EventStoreError {
	constructor(sessionId: SessionId, cause?: unknown) {
		super(`Failed to append event to session: ${sessionId}`, sessionId, cause)
		this.name = 'EventAppendError'
	}
}
