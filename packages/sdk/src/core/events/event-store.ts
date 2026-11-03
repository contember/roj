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
 *
 * An append reports its outcome through the class of what it throws, and the
 * session runtime acts on it:
 * - {@link EventAppendError}: the append definitely did not commit. Later appends proceed.
 * - {@link SessionOwnershipLostError}: it did not commit, and this host no longer
 *   owns the log. The store fences and the runtime stops.
 * - Anything else: the outcome is unknown. The store fences, the runtime stops,
 *   and the next load of the log decides it.
 *
 * An append that does not settle within `writeQueueTimeoutMs` counts as unknown.
 * Throw `EventAppendError` only when nothing can land later.
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

/** The append definitely did not commit; retrying cannot duplicate this attempt. */
export class EventAppendError extends EventStoreError {
	constructor(sessionId: SessionId, cause?: unknown) {
		super(`Failed to append event to session: ${sessionId}`, sessionId, cause)
		this.name = 'EventAppendError'
	}
}

/** The caller must recover from the committed log before deciding whether to retry. */
export class EventAppendOutcomeUnknownError extends EventStoreError {
	constructor(sessionId: SessionId, cause?: unknown) {
		super(`Append outcome is unknown for session: ${sessionId}`, sessionId, cause)
		this.name = 'EventAppendOutcomeUnknownError'
	}
}

/** The store refused a hook event on a closed session before writing anything. */
export class ClosedSessionAppendError extends EventAppendError {
	constructor(sessionId: SessionId, types: readonly string[]) {
		super(sessionId)
		this.message = `Refusing to append session-level hook event(s) to closed session ${sessionId} (types: ${types.join(', ')}). `
			+ `Closed sessions must not re-run plugin session hooks — see session-manager.ts:loadSession closed branch.`
		this.name = 'ClosedSessionAppendError'
	}
}

/**
 * The write was refused because this runtime no longer owns the session.
 *
 * The seam a multi-writer host fences through: an EventStore bound to a host's
 * lease throws this once the lease moved on. The append definitely did not
 * commit, and the runtime that attempted it must stop rather than retry — a
 * replacement is already writing the log.
 */
export class SessionOwnershipLostError extends EventAppendError {
	constructor(sessionId: SessionId, cause?: unknown) {
		super(sessionId, cause)
		this.message = `Session ownership lost: ${sessionId}`
		this.name = 'SessionOwnershipLostError'
	}
}

export class EventLogCorruptionError extends EventStoreError {
	constructor(sessionId: SessionId, public readonly offendingPath: string, cause?: unknown) {
		super(`Corrupt event log: ${offendingPath}`, sessionId, cause)
		this.name = 'EventLogCorruptionError'
	}
}

export class FileEventStoreCapabilityError extends Error {
	constructor() {
		super('FileEventStore requires atomic same-directory FileSystem.rename')
		this.name = 'FileEventStoreCapabilityError'
	}
}
