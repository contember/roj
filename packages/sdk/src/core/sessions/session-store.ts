/**
 * SessionStore - Wrapper over EventStore with in-memory state.
 *
 * Provides a clean API for emitting events and reading state.
 * The state is automatically updated when events are emitted.
 */

import type { AgentId } from '~/core/agents/schema.js'
import type { AgentState } from '~/core/agents/state.js'
import type { EventStore } from '~/core/events/event-store.js'
import { EventAppendError } from '~/core/events/event-store.js'
import type { DomainEvent } from '~/core/events/types.js'
import { applyEvent as coreApplyEvent } from '~/core/sessions/apply-event.js'
import type { SessionReducer } from '~/core/sessions/reducer.js'
import type { SessionId } from '~/core/sessions/schema.js'
import type { SessionState } from '~/core/sessions/state.js'
import { getAgentState, reconstructSessionState } from '~/core/sessions/state.js'

// ============================================================================
// SessionStore
// ============================================================================

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
	private pendingWrites = 0

	constructor(
		readonly sessionId: SessionId,
		private readonly eventStore: EventStore,
		initialState: SessionState,
		applyEvent: SessionReducer = coreApplyEvent,
	) {
		this._state = initialState
		this.applyEvent = applyEvent
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
		return this.pendingWrites > 0
	}

	async waitForIdle(): Promise<void> {
		while (this.pendingWrites > 0) await this.tail
		if (this.failure) throw this.failure.error
	}

	/**
	 * Create a new SessionStore by loading events from EventStore.
	 * Also validates and reconciles metadata if out of sync (e.g., after crash).
	 */
	static async load(
		sessionId: SessionId,
		eventStore: EventStore,
		applyEvent?: SessionReducer,
	): Promise<SessionStore | null> {
		const events = await eventStore.load(sessionId)
		return SessionStore.fromEvents(sessionId, eventStore, events, applyEvent)
	}

	/** Build a store from an event log that the caller already loaded. */
	static async fromEvents(
		sessionId: SessionId,
		eventStore: EventStore,
		events: DomainEvent[],
		applyEvent?: SessionReducer,
	): Promise<SessionStore | null> {
		if (events.length === 0) return null

		const state = reconstructSessionState(events, applyEvent ?? coreApplyEvent)
		if (!state) return null

		// Validate and reconcile metadata if needed (handles crash recovery)
		await eventStore.reconcileMetadata(sessionId, events)

		return new SessionStore(sessionId, eventStore, state, applyEvent)
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
		this.pendingWrites++
		const operation = this.tail.then(async () => {
			if (this.detached) throw new SessionRuntimeDetachedError(this.sessionId, events)
			if (this.fence) throw this.fence.error
			try {
				await append()
			} catch (error) {
				if (!(error instanceof EventAppendError)) this.fence = { error }
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
		this.tail = operation.then(
			() => { this.pendingWrites-- },
			(error: unknown) => {
				this.failure ??= { error }
				this.pendingWrites--
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
