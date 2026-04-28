import z4 from 'zod/v4'
import type { DomainError } from '~/core/errors.js'
import type { Logger } from '~/lib/logger/logger.js'
import type { Result } from '~/lib/utils/result.js'
import type { MailboxMessage } from '../../plugins/mailbox/schema.js'
import type { AgentConfig } from '../agents/agent.js'
import type { AgentContext } from '../agents/context.js'
import type { AgentId } from '../agents/schema.js'
import type { EventStore } from '../events/event-store.js'
import type { BaseEvent, DomainEvent } from '../events/types.js'
import type { ToolResultContent } from '../llm/llm-log-types.js'
import type { LLMLogger } from '../llm/logger.js'
import type { LLMMessage } from '../llm/provider.js'
import type { LLMResponse } from '../llm/state.js'
import type { Preset } from '../preset/index.js'
import type { SessionContext } from '../sessions/context.js'
import type { StateSlice } from '../sessions/reducer.js'
import { createStateSlice } from '../sessions/reducer.js'
import type { SessionManager } from '../sessions/session-manager.js'
import type { SessionState } from '../sessions/state.js'
import type { ToolContext } from '../tools/context.js'
import type { ToolDefinition } from '../tools/definition.js'
import { createTool } from '../tools/definition.js'
import type { ToolResponse } from '../tools/schema.js'
import type { ToolCall } from '../tools/schema.js'
import type {
	AfterInferenceResult,
	AfterToolCallResult,
	BeforeInferenceResult,
	BeforeToolCallResult,
	OnCompleteResult,
	OnErrorResult,
	OnStartResult,
} from './hook-types.js'
import type { PluginDequeueHook, PluginPendingMessages } from './index.js'

// ============================================================================
// Structural supertype for EventsFactory
// ============================================================================

type EventSourceRef = {
	create(type: string, input: unknown): unknown
	EventType: unknown
	Events: unknown
}

// ============================================================================
// Method entry — what .method()/.managerMethod() accumulates as plain TS types
// ============================================================================

type MethodEntry = { input: unknown; output: unknown }
type ManagerMethodEntry = { input: unknown; output: unknown }

// ============================================================================
// Notification types
// ============================================================================

/**
 * Notification entry — registered via .notification() on PluginBuilder.
 * Schema is stored for documentation/validation but not enforced at runtime.
 */
type NotificationEntry = { schema: z4.ZodType }

/**
 * A collected notification — emitted by ctx.notify() during handler/hook execution.
 * Ephemeral (not persisted), broadcast to connected clients via transport.
 */
export interface PluginNotification {
	pluginName: string
	type: string
	payload: unknown
}

// ============================================================================
// Plugin configuration types
// ============================================================================

/**
 * Session-level plugin configuration — binds a plugin name to its session config.
 * Created via `pluginDefinition.configure(config)`.
 */
export interface SessionPluginConfig<TName extends string = string, TConfig = unknown> {
	readonly pluginName: TName
	readonly config: TConfig
	readonly definition: PluginDefinition<TName, TConfig, any, any, any>
}

/**
 * Agent-level plugin configuration — binds a plugin name to its per-agent config.
 * Created via `pluginDefinition.configureAgent(config)`.
 */
export interface AgentPluginConfig<TName extends string = string, TAgentConfig = unknown> {
	readonly pluginName: TName
	readonly config: TAgentConfig
}

// ============================================================================
// Dependency type utilities
// ============================================================================

/**
 * Extract typed session-level method callers from a PluginDefinition.
 * Uses indexed access on _methods brand (pre-resolved types) instead of
 * conditional `infer` on 5-param generic + Zod type extraction.
 */
type PluginMethodCallers<TPlugin extends PluginDefinition<string, any, any, any, any>> = {
	[K in keyof NonNullable<TPlugin['_methods']>]: (
		input: NonNullable<TPlugin['_methods']>[K]['input'],
	) => Promise<Result<NonNullable<TPlugin['_methods']>[K]['output'], DomainError>>
}

/**
 * Build deps object type from an array of PluginDefinition instances.
 * Maps each plugin's TName to its session-level method callers.
 */
export type DepsFromPlugins<TPlugins extends readonly PluginDefinition<string, any, any, any, any>[]> = {
	[P in TPlugins[number] as P['name']]: PluginMethodCallers<P>
}

// ============================================================================
// Caller context
// ============================================================================

/**
 * Identifies who is calling a plugin method.
 * - 'agent': called via agent tool (ctx.self)
 * - 'client': called via SPA RPC (user-initiated)
 * - 'system': called via backend/webhook (trusted)
 */
export type CallerContext = {
	source: 'agent' | 'client' | 'system'
	meta: Record<string, unknown>
}

export const DEFAULT_CALLER: CallerContext = { source: 'client', meta: {} }
export const AGENT_CALLER: CallerContext = { source: 'agent', meta: {} }

// ============================================================================
// Context types
// ============================================================================

/**
 * Context for method handlers — has pluginContext + pluginState + pluginConfig, no self.
 */
export type MethodHandlerContext<TConfig, TContext, TState, TNotifications extends Record<string, NotificationEntry> = {}, TDeps = {}> =
	& SessionContext
	& {
		caller: CallerContext
		pluginConfig: TConfig
		pluginContext: TContext
		pluginState: TState
		scheduleAgent: (agentId: AgentId) => void
		notify: <K extends string & keyof TNotifications>(type: K, payload: z4.infer<TNotifications[K]['schema']>) => void
		deps: TDeps
	}

/**
 * Context for hooks, tools callbacks, status — has self + pluginConfig.
 */
export type PluginHookContext<
	TConfig,
	TMethods extends Record<string, MethodEntry>,
	TAgentConfig,
	TContext,
	TState,
	TNotifications extends Record<string, NotificationEntry> = {},
	TDeps = {},
> = AgentContext & {
	pluginConfig: TConfig
	pluginAgentConfig?: TAgentConfig
	pluginContext: TContext
	pluginState: TState
	self: PluginSelf<TMethods>
	schedule: () => void
	notify: <K extends string & keyof TNotifications>(type: K, payload: z4.infer<TNotifications[K]['schema']>) => void
	deps: TDeps
}

/**
 * Context for session-level hooks — has pluginConfig.
 */
export type PluginSessionHookContext<
	TConfig,
	TMethods extends Record<string, MethodEntry>,
	TContext,
	TState,
	TNotifications extends Record<string, NotificationEntry> = {},
	TDeps = {},
> = SessionContext & {
	pluginConfig: TConfig
	pluginContext: TContext
	pluginState: TState
	self: PluginSelf<TMethods>
	scheduleAgent: (agentId: AgentId) => void
	notify: <K extends string & keyof TNotifications>(type: K, payload: z4.infer<TNotifications[K]['schema']>) => void
	deps: TDeps
}

/**
 * Context for manager-level method handlers — operates outside session context.
 * Used for operations like session creation, listing, preset queries.
 */
export type ManagerMethodContext = {
	sessionManager: SessionManager
	eventStore: EventStore
	presets: Map<string, Preset>
	logger: Logger
	/** Optional LLM logger for LLM call queries */
	llmLogger?: LLMLogger
	/** Host-environment adapters (filesystem, process). */
	platform: import('~/platform/index.js').Platform
}

/**
 * Self accessor — typed method callers derived from accumulated types.
 */
type PluginSelf<TMethods extends Record<string, MethodEntry>> = {
	[K in keyof TMethods]: (input: TMethods[K]['input']) => Promise<Result<TMethods[K]['output'], DomainError>>
}

// ============================================================================
// Hook type map — maps hook name to its extra context fields
// ============================================================================

type HookMap<TCtx> = {
	onStart: (ctx: TCtx) => Promise<OnStartResult>
	beforeInference: (ctx: TCtx & { pendingMessages: MailboxMessage[]; turnNumber: number }) => Promise<BeforeInferenceResult>
	afterInference: (ctx: TCtx & { response: LLMResponse; turnNumber: number }) => Promise<AfterInferenceResult>
	beforeToolCall: (ctx: TCtx & { toolCall: ToolCall }) => Promise<BeforeToolCallResult>
	afterToolCall: (ctx: TCtx & { toolCall: ToolCall; result: { isError: boolean; content: ToolResultContent } }) => Promise<AfterToolCallResult>
	onComplete: (ctx: TCtx) => Promise<OnCompleteResult>
	onError: (ctx: TCtx & { error: string }) => Promise<OnErrorResult>
}

type SessionHookMap<TCtx> = {
	onSessionReady: (ctx: TCtx) => Promise<void>
	onSessionClose: (ctx: TCtx) => Promise<void>
}

// ============================================================================
// Base (erased) context types — what Agent/Session provide at runtime
// ============================================================================

/**
 * Base plugin hook context — agent-level hooks, tools, status, dequeue.
 * This is the type-erased form used by ConfiguredPlugin consumers.
 */
export type BasePluginHookContext = AgentContext & {
	pluginConfig: unknown
	pluginAgentConfig: unknown
	pluginContext: unknown
	pluginState: unknown
	self: Record<string, (input: unknown) => Promise<unknown>>
	schedule: () => void
	notify: (type: string, payload: unknown) => void
	deps: Record<string, Record<string, (input: unknown) => Promise<Result<unknown, DomainError>>>>
}

/**
 * Base session hook context — session-level hooks (onSessionReady, onSessionClose).
 */
export type BaseSessionHookContext = SessionContext & {
	caller: CallerContext
	pluginConfig: unknown
	pluginContext: unknown
	pluginState: unknown
	self: Record<string, (input: unknown) => Promise<unknown>>
	scheduleAgent: (agentId: AgentId) => void
	notify: (type: string, payload: unknown) => void
	deps: Record<string, Record<string, (input: unknown) => Promise<Result<unknown, DomainError>>>>
}

/**
 * Base method handler context — session-level method handlers.
 */
export type BaseMethodHandlerContext = SessionContext & {
	caller: CallerContext
	pluginConfig: unknown
	pluginContext: unknown
	pluginState: unknown
	scheduleAgent: (agentId: AgentId) => void
	notify: (type: string, payload: unknown) => void
	deps: Record<string, Record<string, (input: unknown) => Promise<Result<unknown, DomainError>>>>
}

// ============================================================================
// Erased hook maps — typed return types, erased context
// ============================================================================

/**
 * Agent-level hook map with proper return types but erased context.
 */
type ErasedAgentHookMap = {
	onStart: (ctx: BasePluginHookContext) => Promise<OnStartResult>
	beforeInference: (ctx: BasePluginHookContext & { pendingMessages: MailboxMessage[]; turnNumber: number }) => Promise<BeforeInferenceResult>
	afterInference: (ctx: BasePluginHookContext & { response: LLMResponse; turnNumber: number }) => Promise<AfterInferenceResult>
	beforeToolCall: (ctx: BasePluginHookContext & { toolCall: ToolCall }) => Promise<BeforeToolCallResult>
	afterToolCall: (
		ctx: BasePluginHookContext & { toolCall: ToolCall; result: { isError: boolean; content: ToolResultContent } },
	) => Promise<AfterToolCallResult>
	onComplete: (ctx: BasePluginHookContext) => Promise<OnCompleteResult>
	onError: (ctx: BasePluginHookContext & { error: string }) => Promise<OnErrorResult>
}

/**
 * Session-level hook map with proper return types but erased context.
 */
type ErasedSessionHookMap = {
	onSessionReady: (ctx: BaseSessionHookContext) => Promise<void>
	onSessionClose: (ctx: BaseSessionHookContext) => Promise<void>
}

// ============================================================================
// Output types
// ============================================================================

/**
 * ConfiguredPlugin — runtime-ready plugin instance with config bound.
 * This is the shape that session/runtime code consumes.
 */
export interface ConfiguredPlugin {
	name: string
	methods: Record<string, {
		input: z4.ZodType
		output: z4.ZodType
		handler: (ctx: BaseMethodHandlerContext, input: unknown) => Promise<Result<unknown, DomainError>>
	}>
	/** Registered notification types (for introspection/documentation) */
	notifications: Record<string, { schema: z4.ZodType }>
	/** Names of dependency plugins for runtime wiring */
	dependencyNames: string[]
	createContext?: (ctx: SessionContext) => Promise<unknown>
	state?: {
		key: string
		events: readonly EventSourceRef[]
		initialState: () => unknown
		reduce: (state: unknown, event: DomainEvent, sessionState: SessionState) => unknown
	}
	agentHooks?: Partial<ErasedAgentHookMap>
	sessionHooks?: Partial<ErasedSessionHookMap>
	// ToolDefinition<any> required: ToolDefinition is contravariant in TInput,
	// so ToolDefinition<SpecificInput> is not assignable to ToolDefinition<unknown>
	getTools?: (ctx: BasePluginHookContext) => ToolDefinition<any>[]
	getStatus?: (ctx: BasePluginHookContext) => string | null
	getSystemPrompt?: (ctx: BasePluginHookContext) => string | null
	dequeue?: {
		hasPendingMessages: (ctx: BasePluginHookContext) => boolean
		getPendingMessages: (ctx: BasePluginHookContext) => PluginPendingMessages | null
		markConsumed: (ctx: BasePluginHookContext, token: unknown) => Promise<void>
	}
	slice?: StateSlice
	isEnabled?: (ctx: { pluginConfig: unknown; pluginAgentConfig: unknown; agentConfig: AgentConfig }) => boolean
	isSessionEnabled?: (ctx: { pluginConfig: unknown }) => boolean
}

/**
 * PluginDefinition — static global constant. Call .create(config) to bind config.
 * managerMethods are available without creating a session (manager-level operations).
 */
/** Erased runtime shape for manager methods — used for iteration in SessionManager */
type ManagerMethodRecord = Record<string, {
	input: z4.ZodType
	output: z4.ZodType
	handler: (ctx: ManagerMethodContext, input: unknown) => Promise<Result<unknown, DomainError>>
}>

/** Erased runtime shape for session method schemas — no handler, just input/output */
type SessionMethodSchemaRecord = Record<string, {
	input: z4.ZodType
	output: z4.ZodType
}>

export interface PluginDefinition<
	TName extends string = string,
	TConfig = void,
	TAgentConfig = void,
	TManagerMethods extends Record<string, ManagerMethodEntry> = {},
	TMethods extends Record<string, MethodEntry> = {},
> {
	name: TName
	create(...args: TConfig extends void ? [] : [config: TConfig]): ConfiguredPlugin
	configure(...args: TConfig extends void ? [] : [config: TConfig]): SessionPluginConfig<TName, TConfig>
	configureAgent(...args: TAgentConfig extends void ? [] : [config: TAgentConfig]): AgentPluginConfig<TName, TAgentConfig>
	managerMethods: ManagerMethodRecord
	/** Session-level method schemas — available statically without calling .create() */
	sessionMethods: SessionMethodSchemaRecord
	/** Type-only brand — carries session method types as plain TS types */
	readonly _methods?: TMethods
	/** Type-only brand — carries manager method types as plain TS types */
	readonly _managerMethods?: TManagerMethods
}

// ============================================================================
// Internal config accumulator
// ============================================================================

/**
 * Static tool spec — stored by .tool(), converted to ToolDefinition at runtime.
 * Keeps the 3-arg execute signature so we can bind pluginCtx via closure.
 */
interface StaticToolSpec {
	name: string
	description: string
	input: z4.ZodType
	execute: (input: unknown, toolCtx: ToolContext, pluginCtx: BasePluginHookContext) => Promise<ToolResponse>
}

interface BuilderConfig {
	name: string
	events: readonly EventSourceRef[]
	/** Names of dependency plugins — stored for runtime wiring */
	dependencyNames: string[]
	stateConfig: {
		key: string
		initial: () => unknown
		reduce: (state: unknown, event: unknown, sessionState: SessionState, pluginConfig: unknown) => unknown
	} | undefined
	contextFactory: ((ctx: SessionContext, pluginConfig: unknown) => Promise<unknown>) | undefined
	isSessionEnabledFn: ((ctx: { pluginConfig: unknown }) => boolean) | undefined
	methods: Record<string, {
		input: z4.ZodType
		output: z4.ZodType
		handler: (ctx: BaseMethodHandlerContext, input: unknown) => Promise<Result<unknown, DomainError>>
	}>
	managerMethods: Record<string, {
		input: z4.ZodType
		output: z4.ZodType
		handler: (ctx: ManagerMethodContext, input: unknown) => Promise<Result<unknown, DomainError>>
	}>
	notifications: Record<string, { schema: z4.ZodType }>
	staticTools: StaticToolSpec[]
	dynamicTools: ((ctx: BasePluginHookContext) => ToolDefinition<any>[]) | undefined
	statusFn: ((ctx: BasePluginHookContext) => string | null) | undefined
	systemPromptFn: ((ctx: BasePluginHookContext) => string | null) | undefined
	agentHooks: Partial<ErasedAgentHookMap>
	sessionHooks: Partial<ErasedSessionHookMap>
	isEnabledFn: ((ctx: { pluginConfig: unknown; pluginAgentConfig: unknown; agentConfig: AgentConfig }) => boolean) | undefined
	dequeueHook: {
		hasPendingMessages: (ctx: BasePluginHookContext) => boolean
		getPendingMessages: (ctx: BasePluginHookContext) => PluginPendingMessages | null
		markConsumed: (ctx: BasePluginHookContext, token: unknown) => Promise<void>
	} | undefined
}

// ============================================================================
// PluginBuilder
// ============================================================================

export class PluginBuilder<
	TName extends string,
	TConfig,
	TContext,
	TState,
	TMethods extends Record<string, MethodEntry>,
	TManagerMethods extends Record<string, ManagerMethodEntry>,
	TAgentConfig,
	TFactories extends readonly EventSourceRef[],
	TNotifications extends Record<string, NotificationEntry> = {},
	TDeps = {},
> {
	/** @internal */
	_cfg: BuilderConfig
	/** @internal */
	readonly _name: TName

	constructor(name: TName, cfg?: BuilderConfig) {
		this._name = name
		this._cfg = cfg ?? {
			name,
			events: [],
			dependencyNames: [],
			stateConfig: undefined,
			contextFactory: undefined,
			isSessionEnabledFn: undefined,
			methods: {},
			managerMethods: {},
			notifications: {},
			staticTools: [],
			dynamicTools: undefined,
			statusFn: undefined,
			systemPromptFn: undefined,
			agentHooks: {},
			sessionHooks: {},
			isEnabledFn: undefined,
			dequeueHook: undefined,
		}
	}

	// --- Setup ---

	pluginConfig<T>(): PluginBuilder<TName, T, TContext, TState, TMethods, TManagerMethods, TAgentConfig, TFactories, TNotifications, TDeps> {
		return this as unknown as PluginBuilder<TName, T, TContext, TState, TMethods, TManagerMethods, TAgentConfig, TFactories, TNotifications, TDeps>
	}

	events<const F extends readonly EventSourceRef[]>(
		factories: F,
	): PluginBuilder<TName, TConfig, TContext, TState, TMethods, TManagerMethods, TAgentConfig, F, TNotifications, TDeps> {
		this._cfg.events = factories
		return this as unknown as PluginBuilder<TName, TConfig, TContext, TState, TMethods, TManagerMethods, TAgentConfig, F, TNotifications, TDeps>
	}

	state<S>(config: {
		key: string
		initial: () => S
		reduce: (state: S, event: TFactories[number]['EventType'] & BaseEvent<string>, sessionState: SessionState, pluginConfig: TConfig) => S
	}): PluginBuilder<TName, TConfig, TContext, S, TMethods, TManagerMethods, TAgentConfig, TFactories, TNotifications, TDeps> {
		this._cfg.stateConfig = config as BuilderConfig['stateConfig']
		return this as unknown as PluginBuilder<TName, TConfig, TContext, S, TMethods, TManagerMethods, TAgentConfig, TFactories, TNotifications, TDeps>
	}

	context<C>(
		factory: (ctx: SessionContext, pluginConfig: TConfig) => Promise<C>,
	): PluginBuilder<TName, TConfig, C, TState, TMethods, TManagerMethods, TAgentConfig, TFactories, TNotifications, TDeps> {
		this._cfg.contextFactory = factory as BuilderConfig['contextFactory']
		return this as unknown as PluginBuilder<TName, TConfig, C, TState, TMethods, TManagerMethods, TAgentConfig, TFactories, TNotifications, TDeps>
	}

	agentConfig<A>(): PluginBuilder<TName, TConfig, TContext, TState, TMethods, TManagerMethods, A, TFactories, TNotifications, TDeps> {
		return this as unknown as PluginBuilder<TName, TConfig, TContext, TState, TMethods, TManagerMethods, A, TFactories, TNotifications, TDeps>
	}

	// --- Dependencies ---

	/**
	 * Declare dependencies on other plugins. The dependency plugins' session-level methods
	 * become available as `ctx.deps.pluginName.methodName(input)` in all handler contexts.
	 */
	dependencies<const TPlugins extends readonly PluginDefinition<string, any, any, any, any>[]>(
		plugins: TPlugins,
	): PluginBuilder<TName, TConfig, TContext, TState, TMethods, TManagerMethods, TAgentConfig, TFactories, TNotifications, DepsFromPlugins<TPlugins>> {
		this._cfg.dependencyNames = plugins.map((p) => p.name)
		return this as unknown as PluginBuilder<
			TName,
			TConfig,
			TContext,
			TState,
			TMethods,
			TManagerMethods,
			TAgentConfig,
			TFactories,
			TNotifications,
			DepsFromPlugins<TPlugins>
		>
	}

	// --- Methods ---

	method<TMethodName extends string, TInput, TOutput>(
		name: TMethodName,
		def: {
			input: z4.ZodSchema<TInput>
			output: z4.ZodSchema<TOutput>
			handler: (ctx: MethodHandlerContext<TConfig, TContext, TState, TNotifications, TDeps>, input: TInput) => Promise<Result<TOutput, DomainError>>
		},
	): PluginBuilder<
		TName,
		TConfig,
		TContext,
		TState,
		TMethods & Record<TMethodName, { input: TInput; output: TOutput }>,
		TManagerMethods,
		TAgentConfig,
		TFactories,
		TNotifications,
		TDeps
	> {
		this._cfg.methods[name] = def as BuilderConfig['methods'][string]
		return this as unknown as PluginBuilder<
			TName,
			TConfig,
			TContext,
			TState,
			TMethods & Record<TMethodName, { input: TInput; output: TOutput }>,
			TManagerMethods,
			TAgentConfig,
			TFactories,
			TNotifications,
			TDeps
		>
	}

	// --- Manager Methods ---

	managerMethod<TMethodName extends string, TInput, TOutput>(
		name: TMethodName,
		def: {
			input: z4.ZodSchema<TInput>
			output: z4.ZodSchema<TOutput>
			handler: (ctx: ManagerMethodContext, input: TInput) => Promise<Result<TOutput, DomainError>>
		},
	): PluginBuilder<
		TName,
		TConfig,
		TContext,
		TState,
		TMethods,
		TManagerMethods & Record<TMethodName, { input: TInput; output: TOutput }>,
		TAgentConfig,
		TFactories,
		TNotifications,
		TDeps
	> {
		this._cfg.managerMethods[name] = def as BuilderConfig['managerMethods'][string]
		return this as unknown as PluginBuilder<
			TName,
			TConfig,
			TContext,
			TState,
			TMethods,
			TManagerMethods & Record<TMethodName, { input: TInput; output: TOutput }>,
			TAgentConfig,
			TFactories,
			TNotifications,
			TDeps
		>
	}

	// --- Notifications ---

	notification<TNotifName extends string, TPayload>(
		name: TNotifName,
		def: { schema: z4.ZodSchema<TPayload> },
	): PluginBuilder<
		TName,
		TConfig,
		TContext,
		TState,
		TMethods,
		TManagerMethods,
		TAgentConfig,
		TFactories,
		TNotifications & Record<TNotifName, { schema: typeof def.schema }>,
		TDeps
	> {
		this._cfg.notifications[name] = def
		return this as unknown as PluginBuilder<
			TName,
			TConfig,
			TContext,
			TState,
			TMethods,
			TManagerMethods,
			TAgentConfig,
			TFactories,
			TNotifications & Record<TNotifName, { schema: typeof def.schema }>,
			TDeps
		>
	}

	// --- Tools ---

	tool<TInput>(name: string, def: {
		description: string
		input: z4.ZodSchema<TInput>
		execute: (
			input: TInput,
			toolCtx: ToolContext,
			pluginCtx: PluginHookContext<TConfig, TMethods, TAgentConfig, TContext, TState, TNotifications, TDeps>,
		) => Promise<ToolResponse>
	}): this {
		this._cfg.staticTools.push({
			name,
			description: def.description,
			input: def.input,
			// Erase TInput → unknown at the boundary (PluginBuilder → BuilderConfig)
			execute: def.execute as StaticToolSpec['execute'],
		})
		return this
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolDefinition<TInput> is contravariant, need any for assignment
	tools(fn: (ctx: PluginHookContext<TConfig, TMethods, TAgentConfig, TContext, TState, TNotifications, TDeps>) => ToolDefinition<any>[]): this {
		this._cfg.dynamicTools = fn as BuilderConfig['dynamicTools']
		return this
	}

	// --- Status ---

	status(fn: (ctx: PluginHookContext<TConfig, TMethods, TAgentConfig, TContext, TState, TNotifications, TDeps>) => string | null): this {
		this._cfg.statusFn = fn as BuilderConfig['statusFn']
		return this
	}

	// --- System Prompt ---

	systemPrompt(fn: (ctx: PluginHookContext<TConfig, TMethods, TAgentConfig, TContext, TState, TNotifications, TDeps>) => string | null): this {
		this._cfg.systemPromptFn = fn as BuilderConfig['systemPromptFn']
		return this
	}

	// --- Hooks ---

	hook<TName extends keyof HookMap<PluginHookContext<TConfig, TMethods, TAgentConfig, TContext, TState, TNotifications, TDeps>>>(
		name: TName,
		fn: HookMap<PluginHookContext<TConfig, TMethods, TAgentConfig, TContext, TState, TNotifications, TDeps>>[TName],
	): this {
		;(this._cfg.agentHooks as Record<string, unknown>)[name] = fn
		return this
	}

	sessionHook<TName extends keyof SessionHookMap<PluginSessionHookContext<TConfig, TMethods, TContext, TState, TNotifications, TDeps>>>(
		name: TName,
		fn: SessionHookMap<PluginSessionHookContext<TConfig, TMethods, TContext, TState, TNotifications, TDeps>>[TName],
	): this {
		;(this._cfg.sessionHooks as Record<string, unknown>)[name] = fn
		return this
	}

	// --- Conditional activation ---

	/**
	 * Define a function to determine if this plugin is enabled at session level.
	 * Called once when building plugins for a session.
	 *
	 * @param fn Function that receives plugin config and returns true if plugin should be active
	 */
	isSessionEnabled(
		fn: (ctx: { pluginConfig: TConfig | undefined }) => boolean,
	): this {
		this._cfg.isSessionEnabledFn = fn as BuilderConfig['isSessionEnabledFn']
		return this
	}

	/**
	 * Define a function to determine if this plugin is enabled for a specific agent.
	 * Called once when creating agent plugins.
	 *
	 * @param fn Function that receives context and returns true if plugin should be active
	 */
	isEnabled(
		fn: (ctx: {
			pluginConfig: TConfig
			pluginAgentConfig: TAgentConfig | undefined
			agentConfig: AgentConfig
		}) => boolean,
	): this {
		this._cfg.isEnabledFn = fn as BuilderConfig['isEnabledFn']
		return this
	}

	// --- Dequeue ---

	dequeue<TToken>(hook: PluginDequeueHook<PluginHookContext<TConfig, TMethods, TAgentConfig, TContext, TState, TNotifications, TDeps>, TToken>): this {
		this._cfg.dequeueHook = hook as BuilderConfig['dequeueHook']
		return this
	}

	// --- Build ---

	build(): PluginDefinition<TName, TConfig, TAgentConfig, TManagerMethods, TMethods> {
		const cfg = this._cfg

		// Build session method schemas (input/output only, no handlers)
		const sessionMethods: Record<string, { input: z4.ZodType; output: z4.ZodType }> = {}
		for (const [name, method] of Object.entries(cfg.methods)) {
			sessionMethods[name] = { input: method.input, output: method.output }
		}

		const name = this._name

		const def: PluginDefinition<TName, TConfig, TAgentConfig, TManagerMethods, TMethods> = {
			name,
			create: ((...args: unknown[]) => {
				const pluginConfig = args[0]
				return buildConfiguredPlugin(cfg, pluginConfig)
			}) as PluginDefinition<TName, TConfig, TAgentConfig, TManagerMethods, TMethods>['create'],
			configure: ((...args: unknown[]) => ({
				pluginName: name,
				config: args[0],
				definition: def,
			})) as PluginDefinition<TName, TConfig, TAgentConfig, TManagerMethods, TMethods>['configure'],
			configureAgent: ((...args: unknown[]) => ({
				pluginName: name,
				config: args[0],
			})) as PluginDefinition<TName, TConfig, TAgentConfig, TManagerMethods, TMethods>['configureAgent'],
			managerMethods: cfg.managerMethods,
			sessionMethods,
		}
		return def
	}
}

// ============================================================================
// Build configured plugin — binds config into all closures
// ============================================================================

function buildConfiguredPlugin(cfg: BuilderConfig, pluginConfig: unknown): ConfiguredPlugin {
	let slice: StateSlice | undefined
	if (cfg.stateConfig) {
		const stateReduce = cfg.stateConfig.reduce
		slice = createStateSlice({
			key: cfg.stateConfig.key,
			events: cfg.events,
			initialState: cfg.stateConfig.initial,
			apply: (state, event, sessionState) => stateReduce(state, event, sessionState, pluginConfig),
		})
	}

	const agentHookEntries = Object.entries(cfg.agentHooks) as [string, (ctx: BasePluginHookContext) => Promise<unknown>][]
	const agentHooks: Partial<ErasedAgentHookMap> | undefined = agentHookEntries.length > 0
		? Object.fromEntries(
			agentHookEntries.map(([name, fn]) => [
				name,
				// Agent.ts provides the full context with extra fields (pendingMessages, turnNumber, etc.)
				// — this wrapper just injects pluginConfig at the boundary
				(ctx: BasePluginHookContext) => fn({ ...ctx, pluginConfig }),
			]),
		) as Partial<ErasedAgentHookMap>
		: undefined

	const sessionHookEntries = Object.entries(cfg.sessionHooks)
	const sessionHooks: Partial<ErasedSessionHookMap> | undefined = sessionHookEntries.length > 0
		? Object.fromEntries(
			sessionHookEntries.map(([name, fn]) => [
				name,
				(ctx: BaseSessionHookContext) => fn({ ...ctx, pluginConfig }),
			]),
		) as Partial<ErasedSessionHookMap>
		: undefined

	// Combine static + dynamic tools
	const staticToolSpecs = cfg.staticTools
	const dynamicToolsFn = cfg.dynamicTools
	let getTools: ((ctx: BasePluginHookContext) => ToolDefinition<any>[]) | undefined
	if (staticToolSpecs.length > 0 || dynamicToolsFn) {
		getTools = (ctx: BasePluginHookContext) => {
			const enrichedCtx: BasePluginHookContext = { ...ctx, pluginConfig }
			const tools: ToolDefinition<any>[] = []
			// Static tools — create ToolDefinition from StaticToolSpec using closure
			for (const spec of staticToolSpecs) {
				tools.push(createTool({
					name: spec.name,
					description: spec.description,
					input: spec.input,
					execute: (input, toolCtx) => spec.execute(input, toolCtx, enrichedCtx),
				}))
			}
			// Dynamic tools
			if (dynamicToolsFn) {
				tools.push(...dynamicToolsFn(enrichedCtx))
			}
			return tools
		}
	}

	// Wrap createContext to pass pluginConfig
	const contextFactory = cfg.contextFactory
	const wrappedContextFactory = contextFactory
		? (ctx: SessionContext) => contextFactory(ctx, pluginConfig)
		: undefined

	// Wrap status/systemPrompt/dequeue to inject pluginConfig
	const statusFn = cfg.statusFn
	const wrappedStatus = statusFn
		? (ctx: BasePluginHookContext) => statusFn({ ...ctx, pluginConfig })
		: undefined

	const systemPromptFn = cfg.systemPromptFn
	const wrappedSystemPrompt = systemPromptFn
		? (ctx: BasePluginHookContext) => systemPromptFn({ ...ctx, pluginConfig })
		: undefined

	const dequeueHook = cfg.dequeueHook
	const wrappedDequeue = dequeueHook
		? {
			hasPendingMessages: (ctx: BasePluginHookContext) => dequeueHook.hasPendingMessages({ ...ctx, pluginConfig }),
			getPendingMessages: (ctx: BasePluginHookContext) => dequeueHook.getPendingMessages({ ...ctx, pluginConfig }),
			markConsumed: (ctx: BasePluginHookContext, token: unknown) => dequeueHook.markConsumed({ ...ctx, pluginConfig }, token),
		}
		: undefined

	// Wrap isEnabled to pass pluginConfig
	const wrappedIsEnabled = cfg.isEnabledFn
		? (ctx: { pluginConfig: unknown; pluginAgentConfig: unknown; agentConfig: AgentConfig }) => {
			return cfg.isEnabledFn!({ ...ctx, pluginConfig })
		}
		: undefined

	// Wrap isSessionEnabled to pass pluginConfig
	const wrappedIsSessionEnabled = cfg.isSessionEnabledFn
		? (ctx: { pluginConfig: unknown }) => {
			return cfg.isSessionEnabledFn!({ ...ctx, pluginConfig })
		}
		: undefined

	// Wrap method handlers to inject pluginConfig
	const wrappedMethods: ConfiguredPlugin['methods'] = {}
	for (const [name, method] of Object.entries(cfg.methods)) {
		wrappedMethods[name] = {
			input: method.input,
			output: method.output,
			handler: (ctx, input) => method.handler({ ...ctx, pluginConfig }, input),
		}
	}

	return {
		name: cfg.name,
		methods: wrappedMethods,
		notifications: cfg.notifications,
		dependencyNames: cfg.dependencyNames,
		createContext: wrappedContextFactory,
		state: cfg.stateConfig
			? {
				key: cfg.stateConfig.key,
				events: cfg.events,
				initialState: cfg.stateConfig.initial,
				reduce: (state, event, sessionState) => cfg.stateConfig!.reduce(state, event, sessionState, pluginConfig),
			}
			: undefined,
		agentHooks,
		sessionHooks,
		getTools,
		getStatus: wrappedStatus,
		getSystemPrompt: wrappedSystemPrompt,
		dequeue: wrappedDequeue,
		slice,
		isEnabled: wrappedIsEnabled,
		isSessionEnabled: wrappedIsSessionEnabled,
	}
}

// ============================================================================
// Runtime dependency wiring
// ============================================================================

/**
 * Callback type for resolving a plugin method call at runtime.
 * Used by session.ts and agent.ts to delegate to the session's callPluginMethod.
 */
export type PluginMethodCaller = (pluginName: string, methodName: string, input: unknown) => Promise<Result<unknown, DomainError>>

/**
 * Build a `deps` object for a plugin at runtime.
 * Creates proxy-like method callers for each dependency plugin.
 *
 * @param dependencyNames - Plugin names this plugin depends on
 * @param allPlugins - All configured plugins in the session (to discover method names)
 * @param callMethod - Callback that routes to the session's callPluginMethod
 */
export function buildPluginDeps(
	dependencyNames: string[],
	allPlugins: ConfiguredPlugin[],
	callMethod: PluginMethodCaller,
): Record<string, Record<string, (input: unknown) => Promise<Result<unknown, DomainError>>>> {
	const deps: Record<string, Record<string, (input: unknown) => Promise<Result<unknown, DomainError>>>> = {}

	for (const depName of dependencyNames) {
		const depPlugin = allPlugins.find((p) => p.name === depName)
		if (!depPlugin) continue

		const methods: Record<string, (input: unknown) => Promise<Result<unknown, DomainError>>> = {}
		for (const methodName of Object.keys(depPlugin.methods)) {
			methods[methodName] = (input: unknown) => callMethod(depName, methodName, input)
		}
		deps[depName] = methods
	}

	return deps
}

// ============================================================================
// Entry point
// ============================================================================

export function definePlugin<TName extends string>(name: TName): PluginBuilder<TName, void, void, undefined, {}, {}, void, [], {}, {}> {
	return new PluginBuilder(name)
}
