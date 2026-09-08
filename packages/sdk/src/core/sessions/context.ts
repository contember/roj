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
import type { Result } from '~/lib/utils/result.js'

export class RuntimeFileStore implements FileStore {
	private readonly source: FileStore
	constructor(source: FileStore, private readonly activity: SessionRuntimeActivity) {
		this.source = source instanceof RuntimeFileStore ? source.source : source
	}

	write(path: string, content: string | Buffer) {
		return this.activity.trackResource(() => this.source.write(path, content))
	}

	// Reads pass through. Only a write can land behind the runtime that replaces
	// this one, and these return Result — throwing a lease error out of them breaks
	// the FileStore contract for callers that never mutate anything.
	read(path: string): Promise<Result<string, string>>
	read(path: string, opts: { type: 'buffer' }): Promise<Result<Buffer, string>>
	read(path: string, opts?: { type: 'buffer' }): Promise<Result<string | Buffer, string>> {
		return opts ? this.source.read(path, opts) : this.source.read(path)
	}

	exists(path: string) { return this.source.exists(path) }
	stat(path: string) { return this.source.stat(path) }
	list(path: string, options?: { maxDepth?: number; gitIgnore?: boolean }) {
		return this.source.list(path, options)
	}
	remove(path: string) { return this.activity.trackResource(() => this.source.remove(path)) }
	realPath(path: string) { return this.source.realPath(path) }
	containedPath(path: string) { return this.source.containedPath(path) }
	getRoots() { return this.source.getRoots() }
	scoped(path: string): FileStore { return new RuntimeFileStore(this.source.scoped(path), this.activity) }
	get session(): FileStore { return new RuntimeFileStore(this.source.session, this.activity) }
	get workspace(): FileStore | undefined {
		return this.source.workspace ? new RuntimeFileStore(this.source.workspace, this.activity) : undefined
	}
}

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
	readonly reserveSequence: (name: string, seed: () => number, activity?: SessionRuntimeActivity) => number
	/** Reserve the next live-runtime mailbox sequence synchronously. */
	readonly reserveMailboxMessageSequence: (activity?: SessionRuntimeActivity) => number

	emitEvent: (event: Omit<BaseEvent<string>, 'sessionId'>, activity?: SessionRuntimeActivity) => Promise<void>
	/** Atomically persist and apply related domain events. */
	emitEvents: (events: Array<Omit<BaseEvent<string>, 'sessionId'>>, activity?: SessionRuntimeActivity) => Promise<void>
	/** Send a notification to connected clients via transport (ephemeral, not persisted) */
	notify: (type: string, payload: unknown, activity?: SessionRuntimeActivity) => void
}
