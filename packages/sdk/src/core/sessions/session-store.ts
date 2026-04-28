/**
 * SessionStore - Wrapper over EventStore with in-memory state.
 *
 * Provides a clean API for emitting events and reading state.
 * The state is automatically updated when events are emitted.
 */

import type { AgentId } from '~/core/agents/schema.js'
import type { AgentState } from '~/core/agents/state.js'
import type { EventStore } from '~/core/events/event-store.js'
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
 * SessionStore wraps EventStore and provides:
 * - Event emission with automatic state updates
 * - In-memory state access
 * - Agent state lookup
 */
export class SessionStore {
	private _state: SessionState
	private readonly eventListeners: Array<(event: DomainEvent) => void> = []
	private readonly applyEvent: SessionReducer

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
	 * Create a new SessionStore by loading events from EventStore.
	 * Also validates and reconciles metadata if out of sync (e.g., after crash).
	 */
	static async load(
		sessionId: SessionId,
		eventStore: EventStore,
		applyEvent?: SessionReducer,
	): Promise<SessionStore | null> {
		const events = await eventStore.load(sessionId)
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
		await this.eventStore.append(this.sessionId, event)
		this._state = this.applyEvent(this._state, event)
		this.notifyListeners(event)
	}

	/**
	 * Emit multiple events atomically - writes to EventStore and applies to state.
	 * Listener errors are isolated per-listener so one failure cannot prevent
	 * state application for subsequent events in the batch.
	 */
	async emitBatch(events: DomainEvent[]): Promise<void> {
		if (events.length === 0) return

		await this.eventStore.appendBatch(this.sessionId, events)
		for (const event of events) {
			this._state = this.applyEvent(this._state, event)
			this.notifyListeners(event)
		}
	}

	/**
	 * Notify all listeners about an event, catching per-listener errors
	 * so one failing listener doesn't prevent others from being notified.
	 */
	private notifyListeners(event: DomainEvent): void {
		for (const listener of this.eventListeners) {
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
