import type { LLMMessage } from '../llm/provider.js'

// ============================================================================
// Plugin Dequeue
// ============================================================================

/**
 * Result of getPendingMessages() — messages to inject into the agent's inference,
 * plus an opaque token passed back to markConsumed().
 */
export interface PluginPendingMessages<TToken = unknown> {
	messages: LLMMessage[]
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
