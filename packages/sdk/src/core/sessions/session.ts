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
import { isLiveScheduler } from '~/platform/index.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { getNextMessageSeq, selectMailboxState } from '~/plugins/mailbox/query.js'
import type { MessageId } from '~/plugins/mailbox/schema.js'
import { generateMessageId } from '~/plugins/mailbox/schema.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import { Agent, type AgentConfig } from '../agents/agent.js'
import type { EventStore, SessionOwnershipLostError } from '../events/event-store.js'
import type { BaseEvent } from '../events/types.js'
import { SessionFileStore } from '../file-store/file-store.js'
import type { SessionContext } from '../sessions/context.js'
import { RuntimeFileStore } from '../sessions/context.js'
import type { SessionEnvironment } from '../sessions/session-environment.js'
import type { ToolExecutor } from '../tools/executor.js'
import { SessionStore } from './session-store.js'
import { type RuntimeLeaseRelease, type SessionRuntimeActivity, SessionRuntimeActivityController, SessionRuntimeUnavailableError } from './runtime-activity.js'

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
	/** Called after the runtime stops itself because another host took the log. */
	onOwnershipLost?: (error: SessionOwnershipLostError) => void
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
	private parkPromise?: Promise<void>
	private localCleanup: Promise<void> | undefined
	private cleanupFailed = false
	private revoked = false
	private disposalReason: SessionCloseReason = 'evicted'
	private readonly closeHooks = new Map<ConfiguredPlugin, Promise<void>>()
	private schedulerTail: Promise<void> = Promise.resolve()
	private readonly scopedScheduler = new WeakMap<SessionRuntimeActivity, Promise<void>>()
	private pendingScheduler = 0
	private readonly schedulerErrors: unknown[] = []

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
		// Losing the log is not a drain: a replacement is already writing it, so stop
		// rather than park — nothing this runtime still holds may reach the log again.
		this.store.onOwnershipLost((error) => {
			this.logger.warn('Session ownership lost, abandoning the runtime', { sessionId: this.id })
			this.revoke()
			deps.onOwnershipLost?.(error)
		})
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
		for (const plugin of this.plugins) {
			this.runtimeActivity.assertAvailable()
			if (plugin.createContext) {
				const ctx = await plugin.createContext(this.buildSessionContext(plugin.name))
				this.pluginContexts.set(plugin.name, ctx)
				const state = this.runtimeActivity.getSnapshot().state
				if (state !== 'ready') {
					if (state !== 'parking') await this.runCloseHooks(state === 'revoked' ? 'revoked' : this.disposalReason)
					throw new SessionRuntimeUnavailableError(this.id, state)
				}
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
				const operation = this.runtimeActivity.tryOperation(`ready:${plugin.name}`)
				if (!operation) throw new SessionRuntimeUnavailableError(this.id, this.runtimeActivity.getSnapshot().state)

				try {
					const ctx = this.buildSessionHookContext(plugin, operation.activity)
					await plugin.sessionHooks.onSessionReady(ctx)
				} catch (err) {
					if (this.runtimeActivity.getSnapshot().state === 'revoked') throw err
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
				} finally {
					operation.release()
				}
			}
		}
	}

	/**
	 * Close the session.
	 * Emits session_closed, then awaits the shared runtime disposal path.
	 */
	async close(): Promise<Result<void, DomainError>> {
		return this.mutate('close', () => this.performClose())
	}

	private async performClose(): Promise<Result<void, DomainError>> {
		if (this.store.isClosed()) {
			return Err(SessionErrors.closed(String(this.id)))
		}

		await this.store.emit(withSessionId(this.id, sessionEvents.create('session_closed', {})))
		await this.dispose('closed')

		return Ok(undefined)
	}

	/**
	 * Reopen a freshly acquired closed session; a runtime disposed by close cannot be reused.
	 */
	async reopen(): Promise<Result<void, DomainError>> {
		return this.mutate('reopen', (activity) => this.performReopenRequest(activity))
	}

	private async performReopenRequest(activity: SessionRuntimeActivity): Promise<Result<void, DomainError>> {
		if (!this.store.isClosed()) {
			return Err(ValidationErrors.invalid('Session is not closed'))
		}
		return this.reopenWithEvent(sessionEvents.create('session_reopened', {}), activity)
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
		return this.mutate('overrides', () => this.performSetOverrides(patch))
	}

	private async performSetOverrides(patch: SessionOverridesPatch): Promise<Result<void, DomainError>> {
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
		if (this.runtimeActivity.getSnapshot().state !== 'ready') return
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
		return this.mutate('resume', () => this.performResumeAgent(agentId))
	}

	private async performResumeAgent(agentId: AgentId): Promise<Result<void, DomainError>> {
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
		return this.mutate('pause', (activity) => this.performPauseAgent(agentId, message, activity))
	}

	private async performPauseAgent(agentId: AgentId, message: string | undefined, activity: SessionRuntimeActivity): Promise<Result<void, DomainError>> {
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

		await agent.notifyPaused(message, activity)

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
		return this.mutate('spawn', (activity) => this.performSpawnAgentManually(definitionName, parentId, message, typedInput, activity))
	}

	private async performSpawnAgentManually(
		definitionName: string,
		parentId: AgentId,
		message: string | undefined,
		typedInput: unknown,
		activity: SessionRuntimeActivity,
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

		const seq = this.reserveSequence(agentSequenceKey(definitionName), () => getNextAgentSeq(this.state, definitionName), activity)
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
			const sequence = this.reserveMailboxMessageSequence(activity)
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
		if (!this.disposalPromise) this.disposalReason = reason
		this.runtimeActivity.beginForcedUnload()
		this.disposalPromise ??= Promise.resolve().then(() => this.performDisposal(reason))
		return this.disposalPromise
	}

	private async mutate<T>(reason: string, run: (activity: SessionRuntimeActivity) => Promise<Result<T, DomainError>>): Promise<Result<T, DomainError>> {
		const operation = this.runtimeActivity.tryOperation(reason)
		if (!operation) return Err(SessionErrors.runtimeUnavailable(String(this.id), this.runtimeActivity.getSnapshot().state))
		try {
			return await run(operation.activity)
		} finally { operation.release() }
	}

	park(): Promise<void> {
		if (this.parkPromise) return this.parkPromise
		if (this.runtimeActivity.getSnapshot().state === 'ready') this.runtimeActivity.beginParking()
		for (const agent of this.agents.values()) agent.stopLocalScheduling()
		const parking = this.runtimeActivity.untilRevoked(this.performPark())
		// A park that reports a failure stays retryable. The runtime never returns to
		// `ready`, so it still admits no new work, but a host draining on a deadline
		// can try again before falling back to revoke.
		const guarded: Promise<void> = parking.catch((error: unknown) => {
			const terminal = this.revoked || error instanceof SessionRuntimeUnavailableError
			if (this.parkPromise === guarded && !terminal) this.parkPromise = undefined
			throw error
		})
		this.parkPromise = guarded
		return guarded
	}

	revoke(): void {
		if (this.revoked) return
		this.revoked = true
		this.runtimeActivity.revoke()
		this.store.detach()
		for (const agent of this.agents.values()) agent.revoke()
		this.localCleanup ??= this.runCloseHooks('revoked').finally(() => {
			this.agents.clear()
			this.pluginContexts.clear()
			this.store.clearListeners()
			this.localCleanup = undefined
		})
		void this.localCleanup.catch((error: unknown) => this.logger.error('Revoked runtime cleanup failed', error instanceof Error ? error : new Error(String(error))))
	}

	hasUnsafeResources(): boolean {
		return this.store.hasPendingWrites() || this.localCleanup !== undefined || this.cleanupFailed || this.pendingScheduler > 0 || this.runtimeActivity.hasPendingResources()
	}

	async waitForLocalCleanup(): Promise<void> {
		await this.localCleanup
		await Promise.all(this.closeHooks.values())
	}

	private async performPark(): Promise<void> {
		await this.runtimeActivity.waitForIdle()
		await Promise.all([...this.agents.values()].map((agent) => agent.waitForIdle()))
		await this.store.waitForIdle()
		const teardown = this.runtimeActivity.beginTeardown()
		try {
			this.localCleanup = this.runCloseHooks('parked', teardown.activity)
			await this.localCleanup
		} finally {
			this.localCleanup = undefined
			teardown.release()
		}
		await this.runtimeActivity.waitForIdle()
		await Promise.all([...this.agents.values()].map((agent) => agent.waitForScheduler()))
		await this.schedulerTail
		// Report the failures once and drop them: a scheduler call that definitely
		// failed is settled, and retaining it would refuse every later park.
		const schedulerErrors = this.schedulerErrors.splice(0)
		if (schedulerErrors.length) throw new AggregateError(schedulerErrors, 'Session scheduler operations failed')
		await this.store.waitForIdle()
		if (this.runtimeActivity.getSnapshot().state !== 'parking') throw new SessionRuntimeUnavailableError(this.id, this.runtimeActivity.getSnapshot().state)
		this.store.detach()
		this.store.clearListeners()
		this.agents.clear()
		this.pluginContexts.clear()
		this.runtimeActivity.markDisposed()
	}

	private async runCloseHooks(reason: SessionCloseReason, activity: SessionRuntimeActivity = this.runtimeActivity): Promise<void> {
		const errors: unknown[] = []
		for (const plugin of [...this.plugins].reverse()) {
			if (!plugin.sessionHooks?.onSessionClose) continue
			if (plugin.createContext && !this.pluginContexts.has(plugin.name) && !this.closeHooks.has(plugin)) continue
			try {
				let pending = this.closeHooks.get(plugin)
				if (!pending) {
					const context = this.pluginContexts.get(plugin.name)
					const hook = plugin.sessionHooks.onSessionClose
					pending = Promise.resolve().then(() => {
						const state = this.runtimeActivity.getSnapshot().state
						return hook({
							...this.buildSessionHookContext(plugin, state === 'revoked' ? this.runtimeActivity : activity),
							pluginContext: context,
							reason: state === 'revoked' ? 'revoked' : state === 'unloading' ? this.disposalReason : reason,
						})
					})
					this.closeHooks.set(plugin, pending)
				}
				await pending
			} catch (error) { errors.push(error) }
		}
		if (reason === 'parked' || reason === 'revoked') this.cleanupFailed ||= errors.length > 0
		if (errors.length > 0) throw new AggregateError(errors, 'Session close hooks failed')
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
		if (this.runtimeActivity.getSnapshot().state !== 'ready') return
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
		activity: SessionRuntimeActivity = this.runtimeActivity,
	): Promise<Result<unknown, DomainError>> {
		try { this.runtimeActivity.assertOwnScope(activity) } catch {
			return Err(SessionErrors.runtimeUnavailable(String(this.id), this.runtimeActivity.getSnapshot().state))
		}
		const operation = activity.tryOperation(`plugin:${method}`)
		if (!operation) return Err(SessionErrors.runtimeUnavailable(String(this.id), activity.getSnapshot().state))
		try {
			const result = await this.executePluginMethod(method, input, agentId, caller, operation.activity)
			await this.waitForScopedScheduler(operation.activity)
			return result
		} finally {
			operation.release()
		}
	}

	private async executePluginMethod(
		method: string,
		input: unknown,
		agentId?: AgentId,
		caller?: CallerContext,
		activity: SessionRuntimeActivity = this.runtimeActivity,
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
					...this.buildSessionHookContext(gatePlugin, activity),
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
		const sessionContext = this.buildSessionContext('_session', activity)
		const pluginState = plugin.slice ? plugin.slice.select(this.store.getState()) : undefined
		const pluginContext = this.pluginContexts.get(pluginName)
		const deps = this.buildPluginDeps(plugin, activity)
		const ctx = {
			...sessionContext,
			caller: caller ?? DEFAULT_CALLER,
			logger: this.logger.child({ method, agentId }),
			pluginConfig: undefined,
			pluginContext,
			pluginState,
			scheduleAgent: (targetAgentId: AgentId) => this.scheduleAgent(targetAgentId),
			notify: this.createNotify(pluginName, activity),
			deps,
		}

		try {
			activity.assertAvailable()
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
			getSessionContext: (activity) => this.buildSessionContext('_agent', activity),
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
			pluginMethodCaller: async (depPluginName, methodName, input, activity) => {
				return await this.callPluginMethod(`${depPluginName}.${methodName}`, input, agentState.id, AGENT_CALLER, activity)
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
		const teardown = this.runtimeActivity.beginLegacyTeardown()
		try {
			await this.runCloseHooks(reason, teardown.activity)
		} catch (error) {
			this.logger.error('Session close hooks failed', error instanceof Error ? error : new Error(String(error)))
		}

		// Shutdown all agents
		for (const agent of this.agents.values()) {
			try {
				agent.shutdown(teardown.activity)
			} catch {
				// Suppress errors during shutdown (e.g. AbortError from abort signal listeners)
			}
		}

		try {
			// The shutdown above only aborts; a turn still inside a tool call keeps
			// running against the agents and plugin contexts cleared below.
			await this.drainAgents()
			await this.schedulerTail
		} finally {
			// Clean up references to prevent memory leaks
			this.agents.clear()
			this.pluginContexts.clear()
			this.store.clearListeners()
			// Fence the log last: everything above may still emit legitimately, but
			// whatever outlives disposal now fails instead of writing behind the
			// replacement runtime the manager builds from the same log.
			this.store.detach()
			// An unreleased teardown lease would leave activeCount above zero, so every
			// later waitForIdle hangs and the activity never reaches `disposed`.
			teardown.release()
			this.runtimeActivity.markDisposed()
		}

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
		if (this.runtimeActivity.getSnapshot().state !== 'ready') return
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
	private createNotify(pluginName: string, activity: SessionRuntimeActivity = this.runtimeActivity): SessionContext['notify'] {
		return (type, payload, continuation = activity) => {
			if (!this.canNotify(continuation)) return
			this.onUserOutput?.({ pluginName, type, payload })
		}
	}

	/**
	 * A notification is ephemeral and never persisted, so an expired scope drops it.
	 *
	 * Throwing here would raise into whatever fired it — an interval, a detached
	 * promise, a callback that outlived its method — where nothing is guarding.
	 */
	private canNotify(continuation: SessionRuntimeActivity): boolean {
		try {
			this.runtimeActivity.assertOwnScope(continuation)
			return true
		} catch { return false }
	}

	/**
	 * Build deps object for a plugin — delegates method calls to callPluginMethod.
	 */
	private buildPluginDeps(plugin: ConfiguredPlugin, activity: SessionRuntimeActivity = this.runtimeActivity) {
		return buildPluginDeps(
			plugin.dependencyNames,
			this.plugins,
			async (depPluginName, methodName, input) => {
				return await this.callPluginMethod(`${depPluginName}.${methodName}`, input, undefined, undefined, activity)
			},
		)
	}

	/**
	 * Build a SessionContext from current session state.
	 */
	private buildSessionContext(notificationPluginName = '_session', activity: SessionRuntimeActivity = this.runtimeActivity): SessionContext {
		if (activity !== this.runtimeActivity) this.runtimeActivity.assertOwnScope(activity)
		const env = this.getSessionEnvironment()
		const fileStore = new SessionFileStore(env.sessionDir, env.workspaceDir, env.sandboxed, this.platform.fs)
		return {
			sessionId: this.id,
			sessionState: this.store.getState(),
			getSessionState: () => this.store.getState(),
			sessionInput: undefined,
			environment: env,
			llm: this.llmProvider,
			files: new RuntimeFileStore(fileStore, activity),
			eventStore: this.eventStore,
			llmLogger: this.llmLogger,
			platform: {
				...this.platform,
				scheduler: {
					...(isLiveScheduler(this.platform.scheduler) ? { onWake: this.platform.scheduler.onWake.bind(this.platform.scheduler) } : {}),
					wake: (key, delayMs) => this.runScheduler(activity, () => this.platform.scheduler.wake(key, delayMs)),
					cancel: (key) => this.runScheduler(activity, () => this.platform.scheduler.cancel(key)),
				},
			},
			logger: this.logger,
			runtimeActivity: activity,
			reserveSequence: (name, seed, continuation = activity) => this.reserveSequence(name, seed, continuation),
			reserveMailboxMessageSequence: (continuation = activity) => this.reserveMailboxMessageSequence(continuation),
			emitEvent: async (event, continuation = activity) => {
				this.runtimeActivity.assertOwnScope(continuation)
				const operation = continuation.tryOperation('event')
				if (!operation) throw new SessionRuntimeUnavailableError(this.id, activity.getSnapshot().state)
				try {
					if (event.type === 'session_reopened') {
						const reopened = await this.reopenWithEvent(event, operation.activity)
						if (!reopened.ok) throw new SessionReopenError(reopened.error)
						return
					}
					await this.store.emit(withSessionId(this.id, event))
				} finally { operation.release() }
			},
			emitEvents: async (events, continuation = activity) => {
				this.runtimeActivity.assertOwnScope(continuation)
				const operation = continuation.tryOperation('events')
				if (!operation) throw new SessionRuntimeUnavailableError(this.id, activity.getSnapshot().state)
				try {
					await this.store.emitBatch(events.map((event) => withSessionId(this.id, event)))
				} finally { operation.release() }
			},
			notify: (type, payload, continuation = activity) => {
				if (!this.canNotify(continuation)) return
				this.onUserOutput?.({ pluginName: notificationPluginName, type, payload })
			},
		}
	}

	private runScheduler(activity: SessionRuntimeActivity, run: () => Promise<void>): Promise<void> {
		const operation = activity.tryOperation('scheduler')
		if (!operation) return Promise.reject(new SessionRuntimeUnavailableError(this.id, activity.getSnapshot().state))
		this.pendingScheduler++
		const pending = this.schedulerTail.then(async () => {
			operation.activity.assertAvailable()
			await run()
		})
		this.schedulerTail = pending.then(
			() => { operation.release(); this.pendingScheduler-- },
			(error: unknown) => { operation.release(); this.pendingScheduler--; this.schedulerErrors.push(error) },
		)
		const settled = pending.then(() => undefined, () => undefined)
		const scope = this.scopedScheduler.get(activity)
		this.scopedScheduler.set(activity, scope ? Promise.all([scope, settled]).then(() => undefined) : settled)
		return pending
	}

	async waitForScheduler(): Promise<void> {
		await this.schedulerTail
	}

	/**
	 * Await only the scheduler work this scope armed.
	 *
	 * The session tail orders every wake and cancel, so waiting on it would couple
	 * one call's latency to unrelated ones already queued behind it.
	 */
	private async waitForScopedScheduler(activity: SessionRuntimeActivity): Promise<void> {
		await this.scopedScheduler.get(activity)
	}

	private reserveSequence(name: string, seed: () => number, activity: SessionRuntimeActivity = this.runtimeActivity): number {
		this.runtimeActivity.assertOwnScope(activity)
		if (this.store.isClosed()) {
			throw new Error(`Cannot reserve sequence "${name}" on a closed or disposed session runtime`)
		}
		const sequence = this.sequences.get(name) ?? seed()
		this.sequences.set(name, sequence + 1)
		return sequence
	}

	private reserveMailboxMessageSequence(activity: SessionRuntimeActivity = this.runtimeActivity): number {
		return this.reserveSequence(MAILBOX_MESSAGE_SEQUENCE, () => getNextMessageSeq(selectMailboxState(this.store.getState())), activity)
	}

	private reopenWithEvent(event: Omit<BaseEvent<string>, 'sessionId'>, activity: SessionRuntimeActivity): Promise<Result<void, DomainError>> {
		if (this.reopenPromise) return this.reopenPromise
		const operation = this.performReopen(event, activity)
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

	private async performReopen(event: Omit<BaseEvent<string>, 'sessionId'>, activity: SessionRuntimeActivity): Promise<Result<void, DomainError>> {
		this.runtimeActivity.assertOwnScope(activity)
		const runtimeState = this.runtimeActivity.getSnapshot().state
		if (runtimeState !== 'ready' && runtimeState !== 'parking') {
			return Err(SessionErrors.runtimeUnavailable(String(this.id), runtimeState))
		}
		if (!this.store.isClosed()) return Err(ValidationErrors.invalid('Session is not closed'))
		if (this.store.isDetached()) {
			return Err(SessionErrors.runtimeUnavailable(String(this.id), runtimeState))
		}
		const registrationResult = this.runtimeActivity.getSnapshot().state === 'parking' ? Ok(undefined) : this.registerReopenedSession?.(this) ?? Ok(undefined)
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
	private buildSessionHookContext(plugin: ConfiguredPlugin, activity: SessionRuntimeActivity = this.runtimeActivity): BaseSessionHookContext {
		const sessionContext = this.buildSessionContext('_session', activity)
		const pluginState = plugin.slice ? plugin.slice.select(this.store.getState()) : undefined
		const pluginContext = this.pluginContexts.get(plugin.name)

		// Build self — typed method callers (routed through callPluginMethod for proper context)
		const self: Record<string, (input: unknown) => Promise<unknown>> = {}
		for (const [methodName] of Object.entries(plugin.methods)) {
			self[methodName] = async (input: unknown) => {
				const result = await this.callPluginMethod(`${plugin.name}.${methodName}`, input, undefined, AGENT_CALLER, activity)
				if (!result.ok) {
					throw new Error(`Plugin method failed: ${plugin.name}.${methodName}: ${result.error.type}`)
				}
				return result.value
			}
		}

		const deps = this.buildPluginDeps(plugin, activity)

		return {
			...sessionContext,
			caller: AGENT_CALLER,
			pluginConfig: undefined, // injected by plugin builder wrapper
			pluginContext,
			pluginState,
			self,
			scheduleAgent: (agentId: AgentId) => this.scheduleAgent(agentId),
			notify: this.createNotify(plugin.name, activity),
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
