import type { EventStore } from '~/core/events/event-store'
import type { BaseEvent } from '~/core/events/types'
import type { LLMLogger } from '~/core/llm/logger'
import type { LLMProvider } from '~/core/llm/provider'
import type { Logger } from '~/lib/logger/logger'
import type { Platform } from '~/platform/index.js'
import type { FileStore } from '../file-store/types.js'
import type { SessionId } from './schema.js'
import type { SessionEnvironment } from './session-environment.js'
import type { SessionRuntimeActivity } from './runtime-activity.js'
import type { SessionState } from './state.js'

export type SessionContext<TSessionInput = unknown> = {
	readonly sessionId: SessionId
	/** The full session state (readonly) */
	readonly sessionState: SessionState
	/** Read current session state after the hook snapshot was created. */
	readonly getSessionState: () => SessionState
	/** The typed input if agent has inputSchema, otherwise the task string */
	readonly sessionInput: TSessionInput
	/** Session environment directories */
	readonly environment: SessionEnvironment
	/** LLM inference client for handlers that need LLM access */
	readonly llm: LLMProvider
	/** FileStore with full access - resolves agent-visible paths */
	readonly files: FileStore
	/** Event store for loading/querying events */
	readonly eventStore: EventStore
	/** LLM call logger for debugging and audit */
	readonly llmLogger?: LLMLogger
	/** Host-environment adapters (filesystem, process). */
	readonly platform: Platform

	readonly logger: Logger
	/** Keeps the resident session runtime alive while asynchronous work is pending. */
	readonly runtimeActivity: SessionRuntimeActivity
	/**
	 * Reserve the next value of a named per-session counter, synchronously.
	 *
	 * `seed` supplies the starting value and runs at most once per resident
	 * runtime, on the first reservation after the runtime is built. Deriving the
	 * seed from replayed state is what stops an evicted-and-rebuilt runtime from
	 * restarting the counter and minting ids that collide with the log.
	 */
	readonly reserveSequence: (name: string, seed: () => number) => number
	/** Reserve the next live-runtime mailbox sequence synchronously. */
	readonly reserveMailboxMessageSequence: () => number

	emitEvent: (event: Omit<BaseEvent<string>, 'sessionId'>) => Promise<void>
	/** Atomically persist and apply related domain events. */
	emitEvents: (events: Array<Omit<BaseEvent<string>, 'sessionId'>>) => Promise<void>
	/** Send a notification to connected clients via transport (ephemeral, not persisted) */
	notify: (type: string, payload: unknown) => void
}
