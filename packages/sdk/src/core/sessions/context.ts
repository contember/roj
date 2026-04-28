import type { EventStore } from '~/core/events/event-store'
import type { BaseEvent } from '~/core/events/types'
import type { LLMLogger } from '~/core/llm/logger'
import type { LLMProvider } from '~/core/llm/provider'
import type { Logger } from '~/lib/logger/logger'
import type { Platform } from '~/platform/index.js'
import type { FileStore } from '../file-store/types'
import type { SessionId } from './schema'
import type { SessionEnvironment } from './session-environment'
import type { SessionState } from './state'

export type SessionContext<TSessionInput = unknown> = {
	readonly sessionId: SessionId
	/** The full session state (readonly) */
	readonly sessionState: SessionState
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

	emitEvent: (event: Omit<BaseEvent<string>, 'sessionId'>) => Promise<void>
	/** Send a notification to connected clients via transport (ephemeral, not persisted) */
	notify: (type: string, payload: unknown) => void
}
