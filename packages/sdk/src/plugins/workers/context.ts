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
import { getNextMessageSeq, selectMailboxState } from '~/plugins/mailbox/query.js'
import { generateMessageId } from '~/plugins/mailbox/schema.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import type { Logger } from '../../lib/logger/logger.js'
import type { WorkerSubEvent } from './definition.js'
import type { EmitEvent } from './plugin.js'
import { workerEvents } from './plugin.js'
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
	 * Get current worker state (reconstructed from events).
	 */
	getState(): TState

	/**
	 * Emit a worker-specific event.
	 * The event is persisted and applied to state.
	 */
	emit(event: TSubEvent): Promise<void>

	/**
	 * Check if worker should continue execution.
	 * Returns false if cancelled or session closed.
	 */
	shouldContinue(): boolean

	/**
	 * Check if worker is paused.
	 * Workers should pause their work when this returns true.
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

	private readonly workerType: string
	private readonly emitEvent: EmitEvent
	private readonly getSessionStateCallback: () => SessionState
	private readonly reducer: (state: TState, event: TSubEvent) => TState
	private localState: TState

	/**
	 * Local cancellation flag - provides immediate signal before event is persisted.
	 * This is set by cancel() and checked by shouldContinue() for fast response.
	 */
	private _cancelled = false

	/**
	 * Local pause flag - provides immediate signal before event is persisted.
	 * This is set by pause() and checked by isPaused() for fast response.
	 */
	private _paused = false

	/**
	 * AbortController for cancelling long-running operations.
	 * Aborted when cancel() is called.
	 */
	private readonly abortController = new AbortController()

	private readonly scheduleCallback?: () => void

	constructor(params: {
		sessionId: SessionId
		workerId: WorkerId
		agentId: AgentId
		workerType: string
		files: FileStore
		emitEvent: EmitEvent
		getSessionState: () => SessionState
		reducer: (state: TState, event: TSubEvent) => TState
		initialState: TState
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
		this.reducer = params.reducer
		this.localState = params.initialState
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
		this.localState = this.reducer(this.localState, event)
		await this.emitEvent(workerEvents.create('worker_sub_event', {
			workerId: this.workerId,
			workerType: this.workerType,
			subEvent: event,
		}))
	}

	/**
	 * Check if worker should continue execution.
	 * Returns false if cancelled.
	 */
	shouldContinue(): boolean {
		return !this._cancelled
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
		const messageId = generateMessageId(getNextMessageSeq(selectMailboxState(this.getSessionStateCallback())))

		await this.emitEvent(mailboxEvents.create('mailbox_message', {
			toAgentId: this.agentId,
			message: {
				id: messageId,
				from: this.workerId,
				content: message,
				timestamp: Date.now(),
				consumed: false,
			},
		}))

		this.scheduleCallback?.()
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

	/**
	 * Mark worker as paused.
	 */
	pause(): void {
		this._paused = true
	}

	/**
	 * Resume worker.
	 */
	resume(): void {
		this._paused = false
	}
}
