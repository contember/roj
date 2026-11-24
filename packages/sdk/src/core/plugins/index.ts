import type { LLMMessage } from '../llm/provider.js'
import type { LLMErrorType } from '../llm/schema.js'

// ============================================================================
// Plugin Dequeue
// ============================================================================

/**
 * Result of getPendingMessages() — messages to inject into the agent's inference,
 * plus an opaque token passed back to markConsumed().
 */
export interface PluginPendingMessages<TToken = unknown> {
	messages: LLMMessage[]
	/** Identifies what was dequeued. Compared by its JSON to recognise the same input after a restart. */
	token: TToken
}

/**
 * Dequeue hook — lets a plugin declare pending messages for an agent.
 * The agent loop collects from all plugins before inference, then calls
 * markConsumed() after inference_started.
 */
export interface PluginDequeueHook<TCtx, TToken = unknown> {
	hasPendingMessages: (ctx: TCtx) => boolean
	getPendingMessages: (ctx: TCtx) => PluginPendingMessages<TToken> | null
	markConsumed: (ctx: TCtx, token: TToken) => Promise<void>
	/**
	 * Called instead of `markConsumed` when the provider rejects the turn's content (a non-retryable 4xx other than
	 * 401/403). The source leaves its input out of later turns, and may send a note that it did. Returns whether the
	 * token carried input the provider may have rejected, which keeps `userText` queued for a retry. On any other
	 * non-retryable failure the source's input stays queued.
	 */
	markRejected?: (ctx: TCtx, token: TToken, errorType: LLMErrorType) => Promise<boolean>
	/**
	 * What the source delivers, for a turn the provider rejects. `userText` (the user's messages, answers and context)
	 * stays queued for the next turn when the turn also carried input `markRejected` left out or tool results not yet
	 * replaced by the omission note, which the provider may have rejected instead. Every other input is consumed with
	 * the turn.
	 */
	inputKind?: 'userText'
}

// ============================================================================
// Re-exports from plugin-builder
// ============================================================================

export { buildPluginDeps, definePlugin } from './plugin-builder.js'
export type {
	BaseMethodHandlerContext,
	BasePluginHookContext,
	BaseSessionHookContext,
	ConfiguredPlugin,
	DepsFromPlugins,
	ManagerMethodContext,
	PluginDefinition,
	PluginMethodCaller,
	PluginNotification,
} from './plugin-builder.js'

export type {
	AfterInferenceResult,
	AfterToolCallResult,
	BeforeInferenceResult,
	BeforeToolCallResult,
	HandlerName,
	OnCompleteResult,
	OnStartResult,
} from './hook-types.js'
