/**
 * SessionStore - Wrapper over EventStore with in-memory state.
 *
 * Provides a clean API for emitting events and reading state.
 * The state is automatically updated when events are emitted.
 */

import type { AgentId } from '~/core/agents/schema.js'
import type { AgentState } from '~/core/agents/state.js'
import type { EventStore } from '~/core/events/event-store.js'
import { EventAppendError, EventAppendOutcomeUnknownError } from '~/core/events/event-store.js'
import { withDeadline } from '~/lib/utils/concurrency.js'
import type { DomainEvent } from '~/core/events/types.js'
import { applyEvent as coreApplyEvent } from '~/core/sessions/apply-event.js'
import type { SessionReducer } from '~/core/sessions/reducer.js'
import type { SessionId } from '~/core/sessions/schema.js'
import type { SessionState } from '~/core/sessions/state.js'
import { getAgentState, reconstructSessionState } from '~/core/sessions/state.js'

// ============================================================================
// SessionStore
// ============================================================================

/**
 * Bound on waiting for a turn in the ordered write queue.
 *
 * Appends are serialised so state follows the log, which makes one stalled write
 * block every later one. Waiting forever would wedge close and park, so a turn
 * that never comes fails definitively and fences the store: the stalled head may
 * still land, and nothing may be ordered behind an outcome nobody knows.
 */
export const SESSION_WRITE_QUEUE_TIMEOUT_MS = 30_000

export interface SessionStoreOptions {
	/** Bound on waiting for a turn in the write queue. Defaults to {@link SESSION_WRITE_QUEUE_TIMEOUT_MS}. */
	queueTimeoutMs?: number
}

/** Thrown when a disposed runtime tries to append — see {@link SessionStore.detach}. */
export class SessionRuntimeDetachedError extends Error {
	constructor(readonly sessionId: SessionId, events: readonly DomainEvent[]) {
		const types = [...new Set(events.map((event) => event.type))].join(', ')
		super(`Session runtime for '${sessionId}' is disposed and cannot append events: ${types}`)
		this.name = 'SessionRuntimeDetachedError'
	}
}

/**
 * SessionStore wraps EventStore and provides:
 * - Event emission with automatic state updates
 * - In-memory state access
 * - Agent state lookup
 */
export class SessionStore {
	private _state: SessionState
	private readonly eventListeners: Array<(event: DomainEvent) => void> = []
	private readonly applyEvent: SessionReducer
	private detached = false
	private tail: Promise<void> = Promise.resolve()
	private fence: { error: unknown } | undefined
	private failure: { error: unknown } | undefined
	private readonly pending = new Set<Promise<void>>()

	private readonly queueTimeoutMs: number

	constructor(
		readonly sessionId: SessionId,
		private readonly eventStore: EventStore,
		initialState: SessionState,
		applyEvent: SessionReducer = coreApplyEvent,
		options: SessionStoreOptions = {},
	) {
		this._state = initialState
		this.applyEvent = applyEvent
		this.queueTimeoutMs = options.queueTimeoutMs ?? SESSION_WRITE_QUEUE_TIMEOUT_MS
	}

	/**
	 * Register a listener that is called after each event is emitted and state is updated.
	 * Returns an unsubscribe function to remove the listener.
	 */
	onEvent(listener: (event: DomainEvent) => void): () => void {
		this.eventListeners.push(listener)
		return () => {
			const idx = this.eventListeners.indexOf(listener)
			if (idx >= 0) this.eventListeners.splice(idx, 1)
		}
	}

	/**
	 * Remove all event listeners. Called on session close to prevent leaks.
	 */
	clearListeners(): void {
		this.eventListeners.length = 0
	}

	/**
	 * Fence the store off from its disposed runtime — later emits fail instead of writing.
	 *
	 * The manager rebuilds an evicted session from the log, so a late write from the
	 * old runtime (an abandoned worker, a timer, a settled effect) would land durably
	 * while only the dead projection saw it, and the live one would never catch up.
	 */
	detach(): void {
		this.detached = true
	}

	/** True once the owning runtime was disposed and the store stopped accepting writes. */
	isDetached(): boolean {
		return this.detached
	}

	hasPendingWrites(): boolean {
		return this.pending.size > 0
	}

	/**
	 * Wait for the queue to drain, then report the first write that failed.
	 *
	 * The failure is reported once and cleared: a definite append failure is
	 * settled history, so retaining it would refuse every later park for the life
	 * of the runtime. A {@link fence} is not clearable — it survives here.
	 */
	async waitForIdle(): Promise<void> {
		while (this.pending.size > 0) await Promise.allSettled([...this.pending])
		const failure = this.failure
		this.failure = undefined
		if (failure) throw failure.error
	}

	/**
	 * Create a new SessionStore by loading events from EventStore.
	 * Also validates and reconciles metadata if out of sync (e.g., after crash).
	 */
	static async load(
		sessionId: SessionId,
		eventStore: EventStore,
		applyEvent?: SessionReducer,
		options?: SessionStoreOptions,
	): Promise<SessionStore | null> {
		const events = await eventStore.load(sessionId)
		return SessionStore.fromEvents(sessionId, eventStore, events, applyEvent, options)
	}

	/** Build a store from an event log that the caller already loaded. */
	static async fromEvents(
		sessionId: SessionId,
		eventStore: EventStore,
		events: DomainEvent[],
		applyEvent?: SessionReducer,
		options?: SessionStoreOptions,
	): Promise<SessionStore | null> {
		if (events.length === 0) return null

		const state = reconstructSessionState(events, applyEvent ?? coreApplyEvent)
		if (!state) return null

		// Validate and reconcile metadata if needed (handles crash recovery)
		await eventStore.reconcileMetadata(sessionId, events)

		return new SessionStore(sessionId, eventStore, state, applyEvent, options)
	}

	/**
	 * Emit a single event - writes to EventStore and applies to state.
	 */
	async emit(event: DomainEvent): Promise<void> {
		await this.enqueue([event], () => this.eventStore.append(this.sessionId, event))
	}

	/**
	 * Emit multiple events atomically - writes to EventStore and applies to state.
	 * Listener errors are isolated per-listener so one failure cannot prevent
	 * state application for subsequent events in the batch.
	 */
	async emitBatch(events: DomainEvent[]): Promise<void> {
		await this.enqueue(events, () => this.eventStore.appendBatch(this.sessionId, events))
	}

	private enqueue(events: DomainEvent[], append: () => Promise<void>): Promise<void> {
		if (this.detached) return Promise.reject(new SessionRuntimeDetachedError(this.sessionId, events))
		if (this.fence) return Promise.reject(this.fence.error)
		if (events.length === 0) return Promise.resolve()
		const turn = withDeadline(this.tail, this.queueTimeoutMs, () => {
			this.fence ??= { error: new EventAppendOutcomeUnknownError(this.sessionId, new Error('Session write queue stalled')) }
			return new EventAppendError(this.sessionId, new Error('Timed out waiting for the session write queue'))
		})
		const operation = turn.then(async () => {
			if (this.detached) throw new SessionRuntimeDetachedError(this.sessionId, events)
			if (this.fence) throw this.fence.error
			try {
				await append()
			} catch (error) {
				// Fence unless the store said the append definitely did not commit: an
				// unclassified failure may still have landed, and nothing may be ordered
				// behind an outcome nobody knows.
				if (!(error instanceof EventAppendError)) this.fence ??= { error }
				throw error
			}
			if (this.detached) throw new SessionRuntimeDetachedError(this.sessionId, events)
			try {
				let next = this._state
				for (const event of events) next = this.applyEvent(next, event)
				this._state = next
			} catch (error) {
				this.fence = { error }
				throw error
			}
			for (const event of events) {
				if (this.detached) break
				this.notifyListeners(event)
			}
		})
		this.pending.add(operation)
		this.tail = operation.then(
			() => { this.pending.delete(operation) },
			(error: unknown) => {
				this.failure ??= { error }
				this.pending.delete(operation)
			},
		)
		return operation
	}

	/**
	 * Notify all listeners about an event, catching per-listener errors
	 * so one failing listener doesn't prevent others from being notified.
	 */
	private notifyListeners(event: DomainEvent): void {
		for (const listener of this.eventListeners) {
			if (this.detached) return
			try {
				listener(event)
			} catch (err) {
				console.error('[SessionStore] Listener error:', err)
			}
		}
	}

	/**
	 * Get the current session state.
	 */
	getState(): SessionState {
		return this._state
	}

	/**
	 * Get a specific agent's state.
	 */
	getAgentState(agentId: AgentId): AgentState | null {
		return getAgentState(this._state, agentId)
	}

	/**
	 * Check if the session is closed.
	 */
	isClosed(): boolean {
		return this._state.status === 'closed'
	}
}
