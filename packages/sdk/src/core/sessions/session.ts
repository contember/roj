/**
 * Session - OOP wrapper for session management.
 *
 * Responsibilities:
 * - Factory for agents
 * - User output callback
 * - Plugin method aggregation
 */

import z4 from 'zod/v4'
import { COMMUNICATOR_ROLE, ORCHESTRATOR_ROLE } from '~/core/agents/agent-roles.js'
import { AgentId, generateAgentId } from '~/core/agents/schema.js'
import type { AgentState } from '~/core/agents/state.js'
import { agentEvents, getChildren } from '~/core/agents/state.js'
import { AgentErrors, type DomainError, MethodErrors, SessionErrors, ValidationErrors } from '~/core/errors.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { DomainEvent } from '~/core/events/types.js'
import type { LLMLogger } from '~/core/llm/logger.js'
import { applyMiddleware, type LLMMiddleware } from '~/core/llm/middleware.js'
import type { LLMProvider } from '~/core/llm/provider.js'
import type { AgentPluginConfig, BaseSessionHookContext, CallerContext, ConfiguredPlugin, SessionCloseReason } from '~/core/plugins/plugin-builder.js'
import { AGENT_CALLER, DEFAULT_CALLER, buildPluginDeps, type PluginNotification } from '~/core/plugins/plugin-builder.js'
import type { Preset } from '~/core/preset/index.js'
import type { SessionId } from '~/core/sessions/schema.js'
import type { SessionOverridesPatch, SessionState } from '~/core/sessions/state.js'
import { agentSequenceKey, getEntryAgentId, getNextAgentSeq, sessionEvents } from '~/core/sessions/state.js'
import type { Logger } from '~/lib/logger/logger.js'
import type { Platform } from '~/platform/index.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { getNextMessageSeq, selectMailboxState } from '~/plugins/mailbox/query.js'
import type { MessageId } from '~/plugins/mailbox/schema.js'
import { generateMessageId } from '~/plugins/mailbox/schema.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import { Agent, type AgentConfig } from '../agents/agent.js'
import type { EventStore } from '../events/event-store.js'
import type { BaseEvent } from '../events/types.js'
import { SessionFileStore } from '../file-store/file-store.js'
import type { SessionContext } from '../sessions/context.js'
import type { SessionEnvironment } from '../sessions/session-environment.js'
import type { ToolExecutor } from '../tools/executor.js'
import { SessionStore } from './session-store.js'
import { type RuntimeLeaseRelease, SessionRuntimeActivityController } from './runtime-activity.js'

// ============================================================================
// Types
// ============================================================================

/** Sequence name behind reserveMailboxMessageSequence. */
const MAILBOX_MESSAGE_SEQUENCE = 'mailbox.message'

/** Disposal waits for aborted turns to unwind, but never pins on a wedged one. */
const AGENT_DRAIN_TIMEOUT_MS = 5_000

/**
 * Callback for user-facing output.
 * Receives plugin notifications that are broadcast to connected clients.
 */
export type UserOutputCallback = (notification: PluginNotification) => void

export interface SessionReopenRegistration {
	complete(): Promise<void>
	abort(error: unknown): void
}

class SessionReopenError extends Error {
	constructor(readonly domainError: DomainError) {
		super(domainError.message)
	}
}

/**
 * Dependencies for creating a Session.
 */
export interface SessionDependencies {
	store: SessionStore
	preset: Preset
	llmProvider: LLMProvider
	/** Named provider instances for middleware routing */
	llmProviders?: ReadonlyMap<string, LLMProvider>
	toolExecutor: ToolExecutor
	logger: Logger
	onUserOutput?: UserOutputCallback
	/** Absolute path to session directory */
	sessionDir: string
	/** Configured plugins for this session */
	plugins: ConfiguredPlugin[]
	/** Event store for loading/querying events */
	eventStore: EventStore
	/** LLM call logger for debugging and audit */
	llmLogger?: LLMLogger
	/** Host-environment adapters (filesystem, process). */
	platform: Platform
	/** Lifecycle guard shared by the manager, agents, and plugins. */
	runtimeActivity: SessionRuntimeActivityController
	registerReopenedSession?: (session: Session) => Result<SessionReopenRegistration | undefined, DomainError>
}

// ============================================================================
// Session
// ============================================================================

/**
 * Session manages agents and delegates everything else to plugins.
 */
export class Session {
	readonly id: SessionId
	readonly store: SessionStore
	private readonly preset: Preset
	private readonly llmProvider: LLMProvider
	private readonly llmProviders: ReadonlyMap<string, LLMProvider>
	private readonly toolExecutor: ToolExecutor
	private readonly logger: Logger
	private readonly onUserOutput?: UserOutputCallback
	private readonly sessionDir: string
	private readonly plugins: ConfiguredPlugin[]
	private readonly eventStore: EventStore
	private readonly llmLogger?: LLMLogger
	private readonly platform: Platform
	private readonly runtimeActivity: SessionRuntimeActivityController
	private readonly registerReopenedSession?: SessionDependencies['registerReopenedSession']
	/** Named counters, seeded lazily from replayed state — see SessionContext.reserveSequence. */
	private readonly sequences = new Map<string, number>()

	private readonly agents = new Map<AgentId, Agent>()
	/** Cached plugin contexts created by plugin.createContext() */
	private readonly pluginContexts = new Map<string, unknown>()
	private disposalPromise?: Promise<void>
	private reopenPromise?: Promise<Result<void, DomainError>>

	constructor(deps: SessionDependencies) {
		this.id = deps.store.sessionId
		this.store = deps.store
		this.preset = deps.preset
		this.llmProvider = deps.llmProvider
		this.llmProviders = deps.llmProviders ?? new Map()
		this.toolExecutor = deps.toolExecutor
		this.logger = deps.logger
		this.onUserOutput = deps.onUserOutput
		this.sessionDir = deps.sessionDir
		this.plugins = deps.plugins
		this.eventStore = deps.eventStore
		this.llmLogger = deps.llmLogger
		this.platform = deps.platform
		this.runtimeActivity = deps.runtimeActivity
		this.registerReopenedSession = deps.registerReopenedSession
		// Initialize agents from state
		this.initializeAgents()

		// React to events for agent scheduling
		this.store.onEvent((event) => this.handleStoreEvent(event))
	}

	/**
	 * Get the current session state.
	 */
	get state(): SessionState {
		return this.store.getState()
	}

	/**
	 * Get the preset configuration for this session.
	 */
	getPreset(): Preset {
		return this.preset
	}

	/**
	 * Get the entry agent ID (communicator if present, otherwise orchestrator).
	 */
	getEntryAgentId(): AgentId | null {
		return getEntryAgentId(this.state)
	}

	/**
	 * Initialize plugin contexts.
	 * Must be called before session hooks or plugin methods that need pluginContext.
	 */
	async initPluginContexts(): Promise<void> {
		const sessionContext = this.buildSessionContext()
		for (const plugin of this.plugins) {
			if (plugin.createContext) {
				const ctx = await plugin.createContext(sessionContext)
				this.pluginContexts.set(plugin.name, ctx)
			}
		}
	}

	/**
	 * Call onSessionReady hooks for all plugins (with full context).
	 *
	 * Only errors are persisted as events — successful runs produce no event
	 * to keep the session log focused on state changes, not invocation noise.
	 */
	async callSessionReadyHooks(): Promise<void> {
		for (const plugin of this.plugins) {
			if (plugin.sessionHooks?.onSessionReady) {
				const startTime = Date.now()

				try {
					const ctx = this.buildSessionHookContext(plugin)
					await plugin.sessionHooks.onSessionReady(ctx)
				} catch (err) {
					await this.store.emit(withSessionId(
						this.id,
						sessionEvents.create('session_handler_completed', {
							handlerName: 'onSessionReady',
							pluginName: plugin.name,
							durationMs: Date.now() - startTime,
							error: err instanceof Error ? err.message : String(err),
						}),
					))
					throw err
				}
			}
		}
	}

	/**
	 * Close the session.
	 * Emits session_closed, then awaits the shared runtime disposal path.
	 */
	async close(): Promise<Result<void, DomainError>> {
		if (this.store.isClosed()) {
			return Err(SessionErrors.closed(String(this.id)))
		}

		await this.store.emit(withSessionId(this.id, sessionEvents.create('session_closed', {})))
		await this.dispose('closed')

		return Ok(undefined)
	}

	/**
	 * Reopen a closed session.
	 */
	async reopen(): Promise<Result<void, DomainError>> {
		if (!this.store.isClosed()) {
			return Err(ValidationErrors.invalid('Session is not closed'))
		}
		return this.reopenWithEvent(sessionEvents.create('session_reopened', {}))
	}

	/**
	 * Patch the session's overrides (see {@link SessionOverrides}).
	 *
	 * Takes effect on the next inference each affected agent runs — running agents
	 * are not rebuilt and a request already in flight completes on the model it
	 * started with. Callers are expected to have validated the patch against the
	 * preset; see `unknownOverrideTargets`.
	 */
	async setOverrides(patch: SessionOverridesPatch): Promise<Result<void, DomainError>> {
		if (this.store.isClosed()) {
			return Err(SessionErrors.closed(String(this.id)))
		}

		await this.store.emit(withSessionId(this.id, sessionEvents.create('session_overrides_set', patch)))

		return Ok(undefined)
	}

	/**
	 * Get an agent by ID.
	 */
	getAgent(agentId: AgentId): Agent | null {
		return this.agents.get(agentId) ?? null
	}

	/**
	 * Get the entry agent (communicator or orchestrator).
	 */
	getEntryAgent(): Agent | null {
		const entryId = getEntryAgentId(this.state)
		if (!entryId) return null
		return this.agents.get(entryId) ?? null
	}

	/**
	 * Schedule agent processing (with debounce).
	 */
	scheduleAgent(agentId: AgentId): void {
		const agentState = this.store.getAgentState(agentId)
		if (!agentState || agentState.status === 'paused') return

		const agent = this.agents.get(agentId)
		if (agent) {
			agent.scheduleProcessing()
		}
	}

	/**
	 * Force process an agent (bypass debounce).
	 */
	async forceProcessAgent(agentId: AgentId): Promise<void> {
		const agent = this.agents.get(agentId)
		if (agent) {
			await agent.continue()
		}
	}

	/**
	 * Resume a paused agent so it can continue processing.
	 */
	async resumeAgent(agentId: AgentId): Promise<Result<void, DomainError>> {
		if (this.store.isClosed()) {
			return Err(SessionErrors.closed(String(this.id)))
		}

		const agent = this.agents.get(agentId)
		if (!agent) {
			return Err(AgentErrors.notFound(String(agentId)))
		}

		const agentState = this.store.getAgentState(agentId)
		if (!agentState || (agentState.status !== 'paused' && agentState.status !== 'errored')) {
			return Err(ValidationErrors.invalid('Agent is not paused or errored'))
		}

		await this.store.emit(withSessionId(
			this.id,
			agentEvents.create('agent_resumed', {
				agentId,
			}),
		))

		agent.continue().catch((err) => {
			this.logger.error('Unhandled error in agent.continue()', err instanceof Error ? err : undefined, { sessionId: this.id, agentId })
		})

		this.logger.info('Agent resumed', { sessionId: this.id, agentId })
		return Ok(undefined)
	}

	/**
	 * Pause an agent manually via API.
	 */
	async pauseAgent(agentId: AgentId, message?: string): Promise<Result<void, DomainError>> {
		if (this.store.isClosed()) {
			return Err(SessionErrors.closed(String(this.id)))
		}

		const agent = this.agents.get(agentId)
		if (!agent) {
			return Err(AgentErrors.notFound(String(agentId)))
		}

		const agentState = this.store.getAgentState(agentId)
		if (!agentState || agentState.status === 'paused') {
			return Err(ValidationErrors.invalid('Agent is already paused'))
		}

		await this.store.emit(withSessionId(
			this.id,
			agentEvents.create('agent_paused', {
				agentId,
				reason: 'manual',
				message,
			}),
		))

		await agent.notifyPaused(message)

		this.logger.info('Agent paused', { sessionId: this.id, agentId })
		return Ok(undefined)
	}

	/**
	 * Manually spawn an agent under a given parent.
	 */
	async spawnAgentManually(
		definitionName: string,
		parentId: AgentId,
		message?: string,
		typedInput?: unknown,
	): Promise<Result<AgentId, DomainError>> {
		if (this.store.isClosed()) {
			return Err(SessionErrors.closed(String(this.id)))
		}

		// Validate parent exists
		if (!this.agents.has(parentId)) {
			return Err(AgentErrors.notFound(String(parentId)))
		}

		// Validate definition exists in preset
		const isOrchestrator = definitionName === ORCHESTRATOR_ROLE
		const isCommunicator = definitionName === COMMUNICATOR_ROLE && !!this.preset.communicator
		const isAgent = this.preset.agents.some((a) => a.name === definitionName)
		if (!isOrchestrator && !isCommunicator && !isAgent) {
			return Err(ValidationErrors.invalid(`Agent definition not found: ${definitionName}`))
		}

		// Validate parent is authorized to spawn this definition
		const parentState = this.store.getAgentState(parentId)
		if (parentState) {
			const parentConfig = this.getAgentConfig(parentState.definitionName)
			if (parentConfig.spawnableAgents.length > 0 && !parentConfig.spawnableAgents.includes(definitionName)) {
				return Err(ValidationErrors.invalid(`Agent '${parentState.definitionName}' is not authorized to spawn '${definitionName}'`))
			}

			// Enforce max child agents per parent (default: 20)
			const children = getChildren(this.state, parentId)
			const maxChildren = 20
			if (children.length >= maxChildren) {
				return Err(ValidationErrors.invalid(`Agent '${parentId}' has reached max child agent limit (${maxChildren})`))
			}
		}

		const seq = this.reserveSequence(agentSequenceKey(definitionName), () => getNextAgentSeq(this.state, definitionName))
		const agentId = generateAgentId(definitionName, seq)
		const now = Date.now()

		const events: DomainEvent[] = [
			withSessionId(
				this.id,
				agentEvents.create('agent_spawned', {
					agentId,
					definitionName,
					parentId,
					...(typedInput !== undefined ? { typedInput } : {}),
				}),
			),
		]

		if (message) {
			const sequence = this.reserveMailboxMessageSequence()
			const messageId = generateMessageId(sequence)
			events.push(withSessionId(
				this.id,
				mailboxEvents.create('mailbox_message', {
					toAgentId: agentId,
					sequence,
					message: {
						id: messageId,
						from: parentId,
						content: message,
						timestamp: now,
						consumed: false,
					},
				}),
			))
		}

		await this.store.emitBatch(events)

		this.logger.debug('Agent spawned manually', {
			sessionId: this.id,
			agentId,
			definitionName,
			parentId,
		})

		return Ok(agentId)
	}

	/**
	 * Dispose runtime resources without changing persisted session state.
	 *
	 * `reason` reaches every `onSessionClose` hook, and disposal is idempotent, so
	 * the first caller's reason is the one the hooks see. It defaults to `evicted`
	 * because a bare dispose only drops the runtime — the session survives and the
	 * next access rebuilds it. The paths that really end a session pass `closed`.
	 */
	dispose(reason: SessionCloseReason = 'evicted'): Promise<void> {
		this.runtimeActivity.beginForcedUnload()
		this.disposalPromise ??= Promise.resolve().then(() => this.performDisposal(reason))
		return this.disposalPromise
	}

	/**
	 * Take a runtime lease from outside the session; the caller must release it.
	 *
	 * Returns null once the runtime stopped being `ready`, so losing the race with
	 * eviction reads as "this runtime is gone" instead of resurrecting it.
	 */
	tryAcquireRuntimeLease(reason: string): RuntimeLeaseRelease | null {
		return this.runtimeActivity.tryAcquire(reason)
	}

	/**
	 * Check if a session has any agents that need processing.
	 */
	checkPendingAgents(): void {
		for (const agent of this.agents.values()) {
			agent.continue().catch((err) => {
				this.logger.error('Unhandled error in agent.continue()', err instanceof Error ? err : undefined, { sessionId: this.id, agentId: agent.id })
			})
		}
	}

	/**
	 * Aggregate methods from all plugins.
	 * Returns a map of "pluginName.methodName" → { input, output, handler }.
	 */
	getPluginMethods(): Map<string, ConfiguredPlugin['methods'][string]> {
		const methods = new Map<string, ConfiguredPlugin['methods'][string]>()

		for (const plugin of this.plugins) {
			for (const [methodName, methodDef] of Object.entries(plugin.methods)) {
				methods.set(`${plugin.name}.${methodName}`, methodDef)
			}
		}

		return methods
	}

	/**
	 * Call a plugin method with properly constructed MethodHandlerContext.
	 * The context includes pluginState, pluginConfig (bound in closure),
	 * pluginContext, and scheduleAgent.
	 */
	async callPluginMethod(
		method: string,
		input: unknown,
		agentId?: AgentId,
		caller?: CallerContext,
	): Promise<Result<unknown, DomainError>> {
		if (this.store.isClosed()) return this.executePluginMethod(method, input, agentId, caller)
		const release = this.runtimeActivity.tryAcquire(`plugin:${method}`)
		if (!release) return Err(SessionErrors.notFound(String(this.id)))
		try {
			return await this.executePluginMethod(method, input, agentId, caller)
		} finally {
			release()
		}
	}

	private async executePluginMethod(
		method: string,
		input: unknown,
		agentId?: AgentId,
		caller?: CallerContext,
	): Promise<Result<unknown, DomainError>> {
		// Find the plugin and method by parsing "pluginName.methodName"
		const dotIndex = method.indexOf('.')
		if (dotIndex === -1) {
			return Err(ValidationErrors.invalid(`Invalid method format: ${method}`))
		}
		const pluginName = method.slice(0, dotIndex)
		const methodName = method.slice(dotIndex + 1)

		const plugin = this.plugins.find((p) => p.name === pluginName)
		if (!plugin) {
			return Err(ValidationErrors.invalid(`Unknown plugin: ${pluginName}`))
		}

		const methodDef = plugin.methods[methodName]
		if (!methodDef) {
			return Err(ValidationErrors.invalid(`Unknown method: ${method}`))
		}

		// Validate input
		const parsed = methodDef.input.safeParse(input)
		if (!parsed.success) {
			return Err(ValidationErrors.invalid(`Invalid input for ${method}: ${parsed.error.message}`))
		}

		// beforeMethod gate — any plugin may veto this call before the handler runs
		// (e.g. a budget guard blocking new user input). The hook receives `caller`,
		// so a gate can allow internal AGENT_CALLER traffic (agent-to-agent) while
		// denying external/user-originated calls. First deny wins.
		for (const gatePlugin of this.plugins) {
			if (!gatePlugin.sessionHooks?.beforeMethod) continue
			try {
				const gateCtx = {
					...this.buildSessionHookContext(gatePlugin),
					caller: caller ?? DEFAULT_CALLER,
					method,
					input: parsed.data,
					agentId,
				}
				const gate = await gatePlugin.sessionHooks.beforeMethod(gateCtx)
				if (gate?.action === 'deny') {
					return Err(MethodErrors.denied(gate.reason))
				}
			} catch (err) {
				this.logger.error(`Plugin '${gatePlugin.name}' beforeMethod hook failed`, err instanceof Error ? err : undefined, { method })
			}
		}

		// Build MethodHandlerContext with plugin state, context, scheduleAgent, notify, and deps
		const sessionContext = this.buildSessionContext()
		const pluginState = plugin.slice ? plugin.slice.select(this.store.getState()) : undefined
		const pluginContext = this.pluginContexts.get(pluginName)
		const deps = this.buildPluginDeps(plugin)
		const ctx = {
			...sessionContext,
			caller: caller ?? DEFAULT_CALLER,
			logger: this.logger.child({ method, agentId }),
			pluginConfig: undefined,
			pluginContext,
			pluginState,
			scheduleAgent: (targetAgentId: AgentId) => this.scheduleAgent(targetAgentId),
			notify: this.createNotify(pluginName),
			deps,
		}

		try {
			return await methodDef.handler(ctx, parsed.data)
		} catch (error) {
			if (error instanceof SessionReopenError) return Err(error.domainError)
			throw error
		}
	}

	// ============================================================================
	// Private methods
	// ============================================================================

	/**
	 * Initialize agents from session state.
	 */
	private initializeAgents(): void {
		for (const [agentId, agentState] of this.state.agents) {
			const agent = this.createAgent(agentState)
			this.agents.set(agentId, agent)
		}
	}

	/**
	 * Create an Agent instance from state.
	 */
	private createAgent(agentState: AgentState): Agent {
		const config = this.getAgentConfig(agentState.definitionName)

		// Filter plugins by isEnabled for this specific agent
		const agentPlugins = this.plugins.filter((plugin) => {
			if (!plugin.isEnabled) return true
			return plugin.isEnabled({
				pluginConfig: undefined, // injected by plugin builder wrapper
				pluginAgentConfig: config.plugins?.find(c => c.pluginName === plugin.name)?.config,
				agentConfig: config,
			})
		})

		const env = this.getSessionEnvironment()
		const fileStore = new SessionFileStore(env.sessionDir, env.workspaceDir, env.sandboxed, this.platform.fs)

		// Apply LLM middleware chain: preset-level → agent-level → base provider
		const agentMiddleware = this.getAgentMiddleware(agentState.definitionName)
		const middleware = [
			...(this.preset.llmMiddleware ?? []),
			...agentMiddleware,
		]
		const llmProvider = applyMiddleware(this.llmProvider, middleware)

		return new Agent({
			id: agentState.id,
			getSessionContext: () => this.buildSessionContext('_agent'),
			store: this.store,
			llmProvider,
			llmProviders: this.llmProviders,
			toolExecutor: this.toolExecutor,
			logger: this.logger.child({ agentId: agentState.id }),
			config,
			plugins: agentPlugins,
			environment: env,
			fileStore,
			pluginContexts: this.pluginContexts,
			sendNotification: (n) => this.onUserOutput?.(n),
			pluginMethodCaller: async (depPluginName, methodName, input) => {
				return await this.callPluginMethod(`${depPluginName}.${methodName}`, input, agentState.id, AGENT_CALLER)
			},
			schedule: () => this.scheduleAgent(agentState.id),
		})
	}

	/**
	 * Handle events emitted to the store — reactive scheduling.
	 */
	private handleStoreEvent(event: DomainEvent): void {
		switch (event.type) {
			case 'agent_spawned': {
				const spawned = event as (typeof agentEvents)['Events']['agent_spawned']
				this.handleAgentSpawned(spawned.agentId)
				break
			}
			case 'session_closed': {
				this.dispose('closed').catch((err) => {
					this.logger.error('Unhandled error in session disposal', err instanceof Error ? err : undefined, { sessionId: this.id })
				})
				break
			}
		}
	}

	/**
	 * Call close hooks and release all in-memory runtime state.
	 *
	 * Unlike onSessionReady (which re-throws), onSessionClose intentionally
	 * swallows per-plugin errors so that all plugins get a chance to clean up
	 * and agents are always shut down, even if one plugin's close hook fails.
	 */
	private async performDisposal(reason: SessionCloseReason): Promise<void> {
		// Call onSessionClose for all plugins in REVERSE order (per-plugin isolation)
		const reversedPlugins = [...this.plugins].reverse()
		for (const plugin of reversedPlugins) {
			if (plugin.sessionHooks?.onSessionClose) {
				try {
					const ctx = this.buildSessionHookContext(plugin)
					await plugin.sessionHooks.onSessionClose({ ...ctx, reason })
				} catch (err) {
					this.logger.error(`Session plugin '${plugin.name}' onSessionClose failed`, err instanceof Error ? err : new Error(String(err)), {
						sessionId: this.id,
						pluginName: plugin.name,
					})
				}
			}
		}

		// Shutdown all agents
		for (const agent of this.agents.values()) {
			try {
				agent.shutdown()
			} catch {
				// Suppress errors during shutdown (e.g. AbortError from abort signal listeners)
			}
		}

		// The shutdown above only aborts; a turn still inside a tool call keeps
		// running against the agents and plugin contexts cleared below.
		await this.drainAgents()

		// Clean up references to prevent memory leaks
		this.agents.clear()
		this.pluginContexts.clear()
		this.store.clearListeners()
		// Fence the log last: everything above may still emit legitimately, but
		// whatever outlives disposal now fails instead of writing behind the
		// replacement runtime the manager builds from the same log.
		this.store.detach()
		this.runtimeActivity.markDisposed()

		this.logger.info('Session runtime disposed', { sessionId: this.id, reason })
	}

	/** Await every in-flight turn, bounded — a wedged one must not hold disposal open. */
	private async drainAgents(): Promise<void> {
		const drains = [...this.agents.values()].map((agent) => agent.waitForIdle())
		if (drains.length === 0) return

		let timer: ReturnType<typeof setTimeout> | undefined
		const expiry = new Promise<'expired'>((resolve) => {
			timer = setTimeout(() => resolve('expired'), AGENT_DRAIN_TIMEOUT_MS)
		})
		try {
			const outcome = await Promise.race([Promise.all(drains).then(() => 'drained' as const), expiry])
			if (outcome === 'expired') {
				this.logger.warn('Agent turns did not settle before disposal', {
					sessionId: this.id,
					timeoutMs: AGENT_DRAIN_TIMEOUT_MS,
				})
			}
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	/**
	 * Handle newly spawned agent.
	 */
	private handleAgentSpawned(agentId: AgentId): void {
		// Guard: skip if agent already initialized (e.g., from initializeAgents)
		if (this.agents.has(agentId)) return

		const agentState = this.store.getAgentState(agentId)
		if (!agentState) {
			this.logger.error('Spawned agent not found in state', undefined, {
				sessionId: this.id,
				agentId,
			})
			return
		}

		// Create and register the new agent
		const agent = this.createAgent(agentState)
		this.agents.set(agentId, agent)

		// Schedule processing (with debounce) for the new agent
		agent.scheduleProcessing()
	}

	/**
	 * Handle user-facing output events.
	 */

	/**
	 * Create a notify function bound to a specific plugin name.
	 */
	private createNotify(pluginName: string): (type: string, payload: unknown) => void {
		return (type, payload) => {
			this.onUserOutput?.({ pluginName, type, payload })
		}
	}

	/**
	 * Build deps object for a plugin — delegates method calls to callPluginMethod.
	 */
	private buildPluginDeps(plugin: ConfiguredPlugin) {
		return buildPluginDeps(
			plugin.dependencyNames,
			this.plugins,
			async (depPluginName, methodName, input) => {
				return await this.callPluginMethod(`${depPluginName}.${methodName}`, input)
			},
		)
	}

	/**
	 * Build a SessionContext from current session state.
	 */
	private buildSessionContext(notificationPluginName = '_session'): SessionContext {
		const env = this.getSessionEnvironment()
		const fileStore = new SessionFileStore(env.sessionDir, env.workspaceDir, env.sandboxed, this.platform.fs)
		return {
			sessionId: this.id,
			sessionState: this.store.getState(),
			getSessionState: () => this.store.getState(),
			sessionInput: undefined,
			environment: env,
			llm: this.llmProvider,
			files: fileStore,
			eventStore: this.eventStore,
			llmLogger: this.llmLogger,
			platform: this.platform,
			logger: this.logger,
			runtimeActivity: this.runtimeActivity,
			reserveSequence: (name, seed) => this.reserveSequence(name, seed),
			reserveMailboxMessageSequence: () => this.reserveMailboxMessageSequence(),
			emitEvent: async (event) => {
				if (event.type === 'session_reopened') {
					const reopened = await this.reopenWithEvent(event)
					if (!reopened.ok) throw new SessionReopenError(reopened.error)
					return
				}
				await this.store.emit(withSessionId(this.id, event))
			},
			emitEvents: async (events) => {
				await this.store.emitBatch(events.map((event) => withSessionId(this.id, event)))
			},
			notify: (type, payload) => {
				this.onUserOutput?.({ pluginName: notificationPluginName, type, payload })
			},
		}
	}

	private reserveSequence(name: string, seed: () => number): number {
		const activity = this.runtimeActivity.getSnapshot()
		if (this.store.isClosed() || activity.state !== 'ready') {
			throw new Error(`Cannot reserve sequence "${name}" on a closed or disposed session runtime`)
		}
		const sequence = this.sequences.get(name) ?? seed()
		this.sequences.set(name, sequence + 1)
		return sequence
	}

	private reserveMailboxMessageSequence(): number {
		return this.reserveSequence(MAILBOX_MESSAGE_SEQUENCE, () => getNextMessageSeq(selectMailboxState(this.store.getState())))
	}

	private reopenWithEvent(event: Omit<BaseEvent<string>, 'sessionId'>): Promise<Result<void, DomainError>> {
		if (this.reopenPromise) return this.reopenPromise
		const operation = this.performReopen(event)
		this.reopenPromise = operation
		void operation.then(
			() => {
				if (this.reopenPromise === operation) this.reopenPromise = undefined
			},
			() => {
				if (this.reopenPromise === operation) this.reopenPromise = undefined
			},
		)
		return operation
	}

	private async performReopen(event: Omit<BaseEvent<string>, 'sessionId'>): Promise<Result<void, DomainError>> {
		if (!this.store.isClosed()) return Err(ValidationErrors.invalid('Session is not closed'))
		// A disposed runtime cannot host the reopened session — the manager refuses to
		// re-register it — so reopen through a freshly loaded one instead of writing
		// the event from a handle that is already dead.
		if (this.store.isDetached()) {
			return Err(ValidationErrors.invalid('Session runtime is disposed; load the session again to reopen it'))
		}
		const registrationResult = this.registerReopenedSession?.(this) ?? Ok(undefined)
		if (!registrationResult.ok) return registrationResult
		const registration = registrationResult.value
		try {
			await this.store.emit(withSessionId(this.id, event))
			await registration?.complete()
			return Ok(undefined)
		} catch (error) {
			registration?.abort(error)
			throw error
		}
	}

	/**
	 * Build context for a session-level hook (onSessionReady / onSessionClose).
	 * Provides pluginConfig (via closure), pluginContext, pluginState, self, and session fields.
	 */
	private buildSessionHookContext(plugin: ConfiguredPlugin): BaseSessionHookContext {
		const sessionContext = this.buildSessionContext()
		const pluginState = plugin.slice ? plugin.slice.select(this.store.getState()) : undefined
		const pluginContext = this.pluginContexts.get(plugin.name)

		// Build self — typed method callers (routed through callPluginMethod for proper context)
		const self: Record<string, (input: unknown) => Promise<unknown>> = {}
		for (const [methodName] of Object.entries(plugin.methods)) {
			self[methodName] = async (input: unknown) => {
				const result = await this.callPluginMethod(`${plugin.name}.${methodName}`, input, undefined, AGENT_CALLER)
				if (!result.ok) {
					throw new Error(`Plugin method failed: ${plugin.name}.${methodName}: ${result.error.type}`)
				}
				return result.value
			}
		}

		const deps = this.buildPluginDeps(plugin)

		return {
			...sessionContext,
			caller: AGENT_CALLER,
			pluginConfig: undefined, // injected by plugin builder wrapper
			pluginContext,
			pluginState,
			self,
			scheduleAgent: (agentId: AgentId) => this.scheduleAgent(agentId),
			notify: this.createNotify(plugin.name),
			deps,
		}
	}

	/** What plugins and tools see. Read-only, so a host can assert the posture it resolved. */
	get environment(): SessionEnvironment {
		return this.getSessionEnvironment()
	}

	/**
	 * Get session environment for tool context.
	 */
	private getSessionEnvironment(): SessionEnvironment {
		return {
			sessionDir: this.sessionDir,
			workspaceDir: this.state.workspaceDir,
			sandboxed: this.preset.sandboxed ?? false,
		}
	}

	/**
	 * Get LLM middleware from the agent/orchestrator/communicator definition.
	 */
	private getAgentMiddleware(definitionName: string): LLMMiddleware[] {
		if (definitionName === ORCHESTRATOR_ROLE) return this.preset.orchestrator.llmMiddleware ?? []
		if (definitionName === COMMUNICATOR_ROLE) return this.preset.communicator?.llmMiddleware ?? []
		return this.preset.agents.find(a => a.name === definitionName)?.llmMiddleware ?? []
	}

	/**
	 * Get agent config from preset definition.
	 * Tools are provided by plugins (Agent collects from plugins).
	 */
	private getAgentConfig(definitionName: string): AgentConfig {
		const withServicePluginConfig = (
			config: { services?: { type: string; agentVisible?: boolean }[]; plugins?: AgentPluginConfig[] },
		): AgentPluginConfig[] | undefined => {
			const base = config.plugins ?? []
			// agentVisible: false services stay registered at the session level (SessionManager
			// collects them from agent definitions) but are excluded from the agent's own
			// visibility list — no service_* tools, no session-context status line.
			const visible = (config.services ?? []).filter(s => s.agentVisible !== false)
			if (visible.length === 0) return base.length > 0 ? base : undefined
			// Merge services config into plugins array (if not already present)
			if (base.some(c => c.pluginName === 'services')) return base
			return [...base, { pluginName: 'services', config: { services: visible.map(s => s.type) } }]
		}

		if (definitionName === ORCHESTRATOR_ROLE) {
			const orch = this.preset.orchestrator
			return {
				systemPrompt: orch.system,
				model: orch.model,
				spawnableAgents: orch.agents ?? [],
				tools: orch.tools,
				debounceMs: orch.debounceMs,
				debounceCallback: orch.debounceCallback,
				checkIntervalMs: orch.checkIntervalMs,
				input: orch.input,
				plugins: withServicePluginConfig(orch),
				cacheTtl: orch.cacheTtl,
				errorResumeBackoff: orch.errorResumeBackoff,
			}
		}

		if (definitionName === COMMUNICATOR_ROLE && this.preset.communicator) {
			const comm = this.preset.communicator
			return {
				systemPrompt: comm.system,
				model: comm.model,
				spawnableAgents: comm.agents ?? [],
				tools: comm.tools,
				debounceMs: comm.debounceMs,
				debounceCallback: comm.debounceCallback,
				checkIntervalMs: comm.checkIntervalMs,
				input: comm.input,
				plugins: withServicePluginConfig(comm),
				cacheTtl: comm.cacheTtl,
				errorResumeBackoff: comm.errorResumeBackoff,
			}
		}

		const agentDef = this.preset.agents.find((a) => a.name === definitionName)
		if (!agentDef) {
			throw new Error(`Agent definition not found: ${definitionName}`)
		}

		return {
			systemPrompt: agentDef.system,
			model: agentDef.model,
			spawnableAgents: agentDef.agents ?? [],
			tools: agentDef.tools,
			debounceMs: agentDef.debounceMs,
			debounceCallback: agentDef.debounceCallback,
			checkIntervalMs: agentDef.checkIntervalMs,
			input: agentDef.input,
			plugins: withServicePluginConfig(agentDef),
			cacheTtl: agentDef.cacheTtl,
			errorResumeBackoff: agentDef.errorResumeBackoff,
		}
	}
}
