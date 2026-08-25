/**
 * WorkerContext - context provided to workers during execution.
 *
 * Provides:
 * - State management (event-sourced)
 * - File storage via FileStore
 * - Execution control (pause, cancel)
 * - Communication with owning agent
 */

import type { AgentId } from '~/core/agents/schema.js'
import type { FileStore } from '~/core/file-store/types.js'
import type { SessionId } from '~/core/sessions/schema.js'
import type { SessionState } from '~/core/sessions/state.js'
import { generateMessageId } from '~/plugins/mailbox/schema.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import type { Logger } from '../../lib/logger/logger.js'
import type { WorkerSubEvent } from './definition.js'
import type { EmitEvent } from './state.js'
import { workerEvents } from './state.js'
import { WorkerId } from './worker.js'

// ============================================================================
// WorkerContext Interface
// ============================================================================

/**
 * Context provided to workers during execution.
 *
 * @template TState - Worker state type
 * @template TSubEvent - Worker event type
 */
export interface WorkerContext<TState, TSubEvent extends WorkerSubEvent> {
	/** Session ID */
	readonly sessionId: SessionId

	/** Worker ID */
	readonly workerId: WorkerId

	/** Owning agent ID */
	readonly agentId: AgentId

	/** Logger for debugging */
	readonly logger: Logger

	/** File store for reading/writing files */
	readonly files: FileStore

	/**
	 * True when `execute()` is re-entered for a worker that already ran — after a
	 * runtime rebuild or a `resume`. The state handed to this run is already
	 * reconstructed from the event log, so a resumed worker must continue from
	 * `getState()` rather than start over.
	 */
	readonly resumed: boolean

	/**
	 * Get current worker state (reconstructed from events).
	 */
	getState(): TState

	/**
	 * Emit a worker-specific event.
	 *
	 * Applies the event to local state and persists it — but only while this run is
	 * live: once the run has been stopped (pause, cancel, session close) the emit is
	 * skipped and nothing is persisted.
	 */
	emit(event: TSubEvent): Promise<void>

	/**
	 * Check if worker should continue execution.
	 * Returns false if cancelled or session closed.
	 */
	shouldContinue(): boolean

	/**
	 * Check if a pause was requested for this worker.
	 * A pause also stops execution — `shouldContinue()` goes false and `resume`
	 * re-enters `execute()` — so this only tells a pause from a cancellation.
	 */
	isPaused(): boolean

	/**
	 * Notify the owning agent with a message.
	 * Sends a mailbox message to the agent.
	 */
	notifyAgent(message: string): Promise<void>

	/**
	 * Get current session state.
	 * Workers can read session metadata via getSessionState().metadata.
	 */
	getSessionState(): SessionState

	/**
	 * Get an AbortSignal that is aborted when the worker is cancelled.
	 * Use this to abort long-running operations like fetch() when the worker is cancelled.
	 */
	getAbortSignal(): AbortSignal
}

// ============================================================================
// WorkerContextImpl
// ============================================================================

/**
 * Implementation of WorkerContext.
 */
export class WorkerContextImpl<TState, TSubEvent extends WorkerSubEvent> implements WorkerContext<TState, TSubEvent> {
	readonly sessionId: SessionId
	readonly workerId: WorkerId
	readonly agentId: AgentId
	readonly logger: Logger
	readonly files: FileStore
	readonly resumed: boolean

	private readonly workerType: string
	private readonly emitEvent: EmitEvent
	private readonly getSessionStateCallback: () => SessionState
	private readonly reducer: (state: TState, event: TSubEvent) => TState
	private readonly reserveMailboxMessageSequence: () => number
	private readonly acquireEffectLease: () => (() => void) | null
	private readonly inFlightEffects = new Set<Promise<void>>()
	private readonly effectLeases = new Set<() => void>()
	private localState: TState

	/**
	 * Local cancellation flag - provides immediate signal before event is persisted.
	 * This is set by cancel() and checked by shouldContinue() for fast response.
	 */
	private _cancelled = false

	/** Set by pause() so a winding-down run can tell a pause from a cancellation. */
	private _paused = false

	/**
	 * AbortController for cancelling long-running operations.
	 * Aborted when cancel() is called.
	 */
	private readonly abortController = new AbortController()
	private active = true

	private readonly scheduleCallback?: () => void

	constructor(params: {
		sessionId: SessionId
		workerId: WorkerId
		agentId: AgentId
		workerType: string
		files: FileStore
		emitEvent: EmitEvent
		getSessionState: () => SessionState
		reserveMailboxMessageSequence: () => number
		acquireEffectLease: () => (() => void) | null
		reducer: (state: TState, event: TSubEvent) => TState
		initialState: TState
		resumed: boolean
		logger: Logger
		schedule?: () => void
	}) {
		this.sessionId = params.sessionId
		this.workerId = params.workerId
		this.agentId = params.agentId
		this.workerType = params.workerType
		this.files = params.files
		this.emitEvent = params.emitEvent
		this.getSessionStateCallback = params.getSessionState
		this.reserveMailboxMessageSequence = params.reserveMailboxMessageSequence
		this.acquireEffectLease = params.acquireEffectLease
		this.reducer = params.reducer
		this.localState = params.initialState
		this.resumed = params.resumed
		this.logger = params.logger
		this.scheduleCallback = params.schedule
	}

	/**
	 * Get current worker state (tracked locally).
	 */
	getState(): TState {
		return this.localState
	}

	/**
	 * Emit a worker-specific event.
	 * Applies the event to local state before persisting.
	 */
	async emit(event: TSubEvent): Promise<void> {
		await this.runEffect(async () => {
			this.localState = this.reducer(this.localState, event)
			await this.emitEvent(workerEvents.create('worker_sub_event', {
				workerId: this.workerId,
				workerType: this.workerType,
				subEvent: event,
			}))
		})
	}

	/** Persist a terminal worker event within the context effect lifecycle. */
	async persistTerminal(event: Parameters<EmitEvent>[0]): Promise<boolean> {
		return this.runEffect(async () => {
			await this.emitEvent(event)
		})
	}

	/**
	 * Check if worker should continue execution.
	 * Returns false if cancelled.
	 */
	shouldContinue(): boolean {
		return this.active && !this._cancelled
	}

	/**
	 * Check if worker is paused.
	 * Workers should check this in their main loop and wait when paused.
	 */
	isPaused(): boolean {
		return this._paused
	}

	/**
	 * Notify the owning agent.
	 * NOTE: Uses direct mailbox event emission because mailbox.send() only accepts AgentId
	 * as sender, but workers need to send as WorkerId. Migrate when mailbox.send supports WorkerId.
	 */
	async notifyAgent(message: string): Promise<void> {
		await this.runEffect(async () => {
			const sequence = this.reserveMailboxMessageSequence()
			const messageId = generateMessageId(sequence)

			await this.emitEvent(mailboxEvents.create('mailbox_message', {
				toAgentId: this.agentId,
				sequence,
				message: {
					id: messageId,
					from: this.workerId,
					content: message,
					timestamp: Date.now(),
					consumed: false,
				},
			}))

			if (this.active) this.scheduleCallback?.()
		})
	}

	/**
	 * Get current session state.
	 */
	getSessionState(): SessionState {
		return this.getSessionStateCallback()
	}

	/**
	 * Get AbortSignal for cancelling long-running operations.
	 */
	getAbortSignal(): AbortSignal {
		return this.abortController.signal
	}

	/**
	 * Mark worker as cancelled and abort any pending operations.
	 */
	cancel(): void {
		this._cancelled = true
		this.abortController.abort()
	}

	/** Permanently disable callbacks — the worker is stopping and will never resume this run. */
	invalidate(): void {
		this.active = false
		this.cancel()
	}

	/** Wait for effects that started before invalidation. */
	async waitForEffects(): Promise<void> {
		await Promise.allSettled([...this.inFlightEffects])
	}

	/** Give back the leases of effects that outlived their drain deadline, so a stalled write cannot pin the runtime forever. */
	releaseEffectLeases(): void {
		for (const release of this.effectLeases) release()
		this.effectLeases.clear()
	}

	private async runEffect(effect: () => Promise<void>): Promise<boolean> {
		if (!this.active) return false
		// The runtime can start unloading between the check above and here — skip the
		// effect rather than throw a lease error into worker code.
		const releaseLease = this.acquireEffectLease()
		if (!releaseLease) return false
		this.effectLeases.add(releaseLease)
		let promise: Promise<void> | undefined
		try {
			promise = effect()
			this.inFlightEffects.add(promise)
			await promise
		} finally {
			if (promise) this.inFlightEffects.delete(promise)
			this.effectLeases.delete(releaseLease)
			releaseLease()
		}
		return true
	}

	/**
	 * Record that this run is stopping because of a pause, not a cancellation.
	 */
	pause(): void {
		this._paused = true
	}
}
