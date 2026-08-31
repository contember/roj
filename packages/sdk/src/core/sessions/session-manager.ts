/**
 * SessionManager - Session lifecycle and cache management.
 *
 * Responsibilities:
 * - Create and cache sessions
 * - Load sessions from event store
 * - Shutdown and cleanup
 */

import { join } from 'node:path'
import z4 from 'zod/v4'
import { COMMUNICATOR_ROLE, ORCHESTRATOR_ROLE } from '~/core/agents/agent-roles.js'
import { parseAgentWakeKey, parsePluginWakeKey } from '~/core/wake-key.js'
import { AgentId, generateAgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { type DomainError, PresetErrors, SessionErrors, ValidationErrors } from '~/core/errors.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { DomainEvent } from '~/core/events/types.js'
import type { FileStore } from '~/core/file-store/types.js'
import type { LLMLogger } from '~/core/llm/logger.js'
import type { LLMProvider } from '~/core/llm/provider.js'
import { DEFAULT_PLUGIN_ORDER } from '~/core/plugins/plugin-builder.js'
import type { CallerContext, ConfiguredPlugin, ManagerMethodContext, PluginDefinition, SessionCloseReason } from '~/core/plugins/plugin-builder.js'
import { AGENT_CALLER } from '~/core/plugins/plugin-builder.js'
import type { Preset } from '~/core/preset/index.js'
import { knownDefinitionNames, unknownOverrideTargets } from '~/core/preset/overrides.js'
import type { SessionMetadata } from '~/core/sessions/schema.js'
import { generateSessionId, isValidSessionId, SessionId } from '~/core/sessions/schema.js'
import type { SessionCreatedEvent, SessionOverridesPatch } from '~/core/sessions/state.js'
import { checkRecoveryNeeded, isSessionCreatedEvent, reconstructSessionState, sessionEvents } from '~/core/sessions/state.js'
import type { ToolExecutor } from '~/core/tools'
import type { ArchiveLimitOverrides } from '~/lib/archive/index.js'
import type { Logger } from '~/lib/logger/logger.js'
import { createSessionLogger } from '~/lib/logger/session-log.js'
import { TeeLogger } from '~/lib/logger/tee.js'
import type { Platform } from '~/platform/index.js'
import { isLiveScheduler } from '~/platform/index.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { SpawnableAgentInfo } from '~/plugins/agents/index.js'
import { getAgentUnconsumedMailbox, selectMailboxState } from '~/plugins/mailbox/query.js'
import type { ServicePidRegistry } from '~/plugins/services/pid-registry.js'
import type { PortPool } from '~/plugins/services/port-pool.js'
import type { ServiceConfig } from '~/plugins/services/schema.js'
import { selectSessionStats, type SessionStatsState } from '~/plugins/session-stats/index.js'
import type { PreprocessorRegistry } from '~/plugins/uploads/preprocessor.js'
import { EventStore } from '../events/event-store.js'
import { createApplyEvent } from './apply-event.js'
import { rewriteEventsForFork } from './fork-utils.js'
import { SessionStore } from './session-store.js'
import { Session, type SessionReopenRegistration, type UserOutputCallback } from './session.js'
import { SessionRuntimeActivityController } from './runtime-activity.js'

// ============================================================================
// Errors
// ============================================================================

/**
 * Internal error for session loading failures.
 * Wraps DomainError for proper error handling in async loading.
 */
class SessionLoadError extends Error {
	constructor(public readonly domainError: DomainError) {
		super(`Session load error: ${domainError.type}`)
		this.name = 'SessionLoadError'
	}
}

// ============================================================================
// SessionManager
// ============================================================================

export interface SessionManagerOptions {
	eventStore: EventStore
	llmProvider: LLMProvider
	/** Named provider instances for middleware routing */
	llmProviders?: ReadonlyMap<string, LLMProvider>
	toolExecutor: ToolExecutor
	presets: Map<string, Preset>
	logger: Logger
	basePath: string
	dataFileStore: FileStore
	onUserOutput?: UserOutputCallback
	preprocessorRegistry?: PreprocessorRegistry
	uploadArchiveLimits?: ArchiveLimitOverrides
	resourceArchiveLimits?: ArchiveLimitOverrides
	llmLogger?: LLMLogger
	portPool?: PortPool
	pidRegistry?: ServicePidRegistry
	/** Host-environment adapters (filesystem, process). */
	platform: Platform
	systemPlugins?: readonly PluginDefinition<string, any, any, any, any>[]
	/** Evict resident runtimes after this idle period. Absent or zero disables eviction. */
	sessionIdleTimeoutMs?: number
}

interface SessionCacheEntry {
	state: 'loading' | 'ready' | 'evicting'
	promise: Promise<Session>
	activity: SessionRuntimeActivityController
	lastAccessAt: number
	unloadPromise?: Promise<void>
	listenerCleanup?: () => void
}

/** Why the manager is dropping a resident runtime — finer-grained than what plugins see. */
type RuntimeDisposalCause = 'idle' | 'closed' | 'disposed' | 'shutdown'

// Both parking causes map to `evicted`: the session survives and the next access rebuilds its runtime.
const RUNTIME_DISPOSAL_CLOSE_REASON: Record<RuntimeDisposalCause, SessionCloseReason> = {
	idle: 'evicted',
	disposed: 'evicted',
	closed: 'closed',
	shutdown: 'shutdown',
}

export interface AcquiredSessionLease {
	session: Session
	release: () => void
}

/**
 * SessionManager manages session lifecycle and caching.
 */
export class SessionManager {
	private readonly sessions = new Map<SessionId, SessionCacheEntry>()
	/** Manager-level methods collected from plugin definitions across all presets */
	private readonly managerMethods: Map<string, {
		input: z4.ZodType
		output: z4.ZodType
		handler: (ctx: ManagerMethodContext, input: unknown) => Promise<Result<unknown, DomainError>>
	}>

	private readonly eventStore: EventStore
	private readonly llmProvider: LLMProvider
	private readonly llmProviders: ReadonlyMap<string, LLMProvider>
	private readonly toolExecutor: ToolExecutor
	private readonly presets: Map<string, Preset>
	private readonly logger: Logger
	private readonly basePath: string
	private readonly dataFileStore: FileStore
	private readonly onUserOutput?: UserOutputCallback
	private readonly preprocessorRegistry?: PreprocessorRegistry
	private readonly uploadArchiveLimits?: ArchiveLimitOverrides
	private readonly resourceArchiveLimits?: ArchiveLimitOverrides
	private readonly llmLogger?: LLMLogger
	private readonly portPool?: PortPool
	private readonly pidRegistry?: ServicePidRegistry
	private readonly platform: Platform
	private readonly systemPlugins: readonly PluginDefinition<string, any, any, any, any>[]
	private readonly sessionIdleTimeoutMs: number
	private readonly evictionSweepTimer?: ReturnType<typeof setInterval>
	private cacheHits = 0
	private cacheMisses = 0
	private cacheEvictions = 0
	/** Set by shutdown(). Also fences wakes: one armed before it must not reload a session after it. */
	private shuttingDown = false

	constructor(options: SessionManagerOptions) {
		if (options.sessionIdleTimeoutMs !== undefined && (!Number.isSafeInteger(options.sessionIdleTimeoutMs) || options.sessionIdleTimeoutMs < 0)) {
			throw new Error(`Invalid sessionIdleTimeoutMs: ${options.sessionIdleTimeoutMs}`)
		}
		this.eventStore = options.eventStore
		this.llmProvider = options.llmProvider
		this.llmProviders = options.llmProviders ?? new Map()
		this.toolExecutor = options.toolExecutor
		this.presets = options.presets
		this.logger = options.logger
		this.basePath = options.basePath
		this.dataFileStore = options.dataFileStore
		this.onUserOutput = options.onUserOutput
		this.preprocessorRegistry = options.preprocessorRegistry
		this.uploadArchiveLimits = options.uploadArchiveLimits
		this.resourceArchiveLimits = options.resourceArchiveLimits
		this.llmLogger = options.llmLogger
		this.portPool = options.portPool
		this.pidRegistry = options.pidRegistry
		this.platform = options.platform
		this.systemPlugins = options.systemPlugins ?? []
		this.sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? 0
		this.managerMethods = this.collectManagerMethods()
		if (this.sessionIdleTimeoutMs > 0) {
			const sweepIntervalMs = Math.min(this.sessionIdleTimeoutMs, 60_000)
			this.evictionSweepTimer = setInterval(() => {
				void this.evictIdleSessions()
			}, sweepIntervalMs)
			this.evictionSweepTimer.unref()
		}

		// A live scheduler has nowhere else to deliver. Hosts that wake out-of-band
		// (a Durable Object alarm) call dispatchWake() from their own handler.
		const scheduler = this.platform.scheduler
		if (isLiveScheduler(scheduler)) {
			scheduler.onWake(async (key) => {
				try {
					await this.dispatchWake(key)
				} catch (error) {
					this.logger.error('Scheduler wake dispatch failed', error instanceof Error ? error : new Error(String(error)), { key })
				}
			})
		}
	}

	/** Expose platform adapters (used by Session for building contexts). */
	getPlatform(): Platform {
		return this.platform
	}

	/**
	 * Deliver a scheduler wake that has come due.
	 *
	 * The host's entry point back into the SDK — on Cloudflare, called from
	 * `alarm()` in an isolate that never armed the wake. SessionManager owns it
	 * because it is the only thing that can turn a session id back into a live
	 * session, so the key alone is enough input.
	 *
	 * Two vocabularies route here: `agent:` wakes re-enter the agent loop,
	 * `plugin:` wakes call a plugin method. Anything else is a quiet no-op, and so
	 * is a key naming a session, agent or plugin that is gone — wakes outlive what
	 * they point at. Only genuinely unexpected failures (event store IO) throw, so
	 * a host that retries alarms retries those and only those.
	 */
	async dispatchWake(key: string): Promise<void> {
		const agentWake = parseAgentWakeKey(key)
		if (agentWake) {
			await this.withWakeTarget(key, agentWake.sessionId, async (session) => {
				await session.getAgent(agentWake.agentId)?.deliverWake(agentWake.kind)
			})
			return
		}

		const pluginWake = parsePluginWakeKey(key)
		if (pluginWake) {
			await this.withWakeTarget(key, pluginWake.sessionId, async (session) => {
				const result = await session.callPluginMethod(
					`${pluginWake.pluginName}.${pluginWake.method}`,
					pluginWake.agentId === undefined ? {} : { agentId: pluginWake.agentId },
					pluginWake.agentId,
					AGENT_CALLER,
				)
				// A preset that no longer registers the plugin lands here, same as a
				// missing agent does: the wake points at something that is gone.
				if (!result.ok) this.logger.debug('Scheduler wake method rejected', { key, error: result.error.type })
			})
			return
		}

		this.logger.debug('Ignoring unrecognized scheduler wake key', { key })
	}

	/** Run `deliver` against the session a due wake names, under a runtime lease. */
	private async withWakeTarget(key: string, sessionId: SessionId, deliver: (session: Session) => Promise<void>): Promise<void> {
		// Nothing armed before shutdown may load a session back in afterwards.
		if (this.shuttingDown) return
		// Nor may a wake that lands mid-teardown rebuild what is being torn down —
		// getSession() would wait out the unload and reload. onSessionReady re-arms.
		const resident = this.sessions.get(sessionId)
		if (resident && (resident.state === 'evicting' || resident.activity.getSnapshot().state !== 'ready')) return

		const sessionResult = await this.getSession(sessionId)
		if (!sessionResult.ok) {
			this.logger.debug('Scheduler wake for a session that no longer loads', { key, error: sessionResult.error.type })
			return
		}
		const session = sessionResult.value
		// A closed session's log is sealed; re-entering it would only fail to write.
		if (session.state.status === 'closed') return

		// Lease the delivery, not the delay before it — an idle session stays evictable while it waits.
		const release = session.tryAcquireRuntimeLease(`wake:${key}`)
		if (!release) return
		try {
			await deliver(session)
		} finally {
			release()
		}
	}

	/**
	 * Create a new session with the given preset.
	 */
	async createSession(
		presetId: string,
		options?: { workspaceDir?: string; sessionId?: string; overrides?: SessionOverridesPatch },
	): Promise<Result<Session, DomainError>> {
		if (this.shuttingDown) return Err(ValidationErrors.invalid('Session manager is shutting down'))
		const preset = this.presets.get(presetId)
		if (!preset) {
			return Err(PresetErrors.notFound(presetId))
		}

		if (options?.overrides) {
			const unknown = unknownOverrideTargets(preset, options.overrides)
			if (unknown.length > 0) {
				return Err(ValidationErrors.invalid(
					`Unknown agent definitions in overrides: ${unknown.join(', ')}. Preset '${presetId}' defines: ${knownDefinitionNames(preset).join(', ')}`,
				))
			}
		}

		// Validate before anything derives a path from it — the id reaches join() for the
		// session dir, the event log and the file logger, and path.join collapses `..`.
		if (options?.sessionId !== undefined && !isValidSessionId(options.sessionId)) {
			return Err(ValidationErrors.invalid(`Invalid session id: ${JSON.stringify(options.sessionId)}`))
		}
		const sessionId = options?.sessionId ? SessionId(options.sessionId) : generateSessionId()
		// First orchestrator gets seq 1
		const orchestratorId = generateAgentId(ORCHESTRATOR_ROLE, 1)

		// Resolve workspaceDir: API input overrides preset default
		// Interpolate {sessionId} placeholder if present
		const rawWorkspaceDir = options?.workspaceDir ?? preset.workspaceDir
		const workspaceDir = rawWorkspaceDir?.replace('{sessionId}', String(sessionId))

		this.logger.info('Creating session', {
			sessionId,
			presetId,
			optionsWorkspaceDir: options?.workspaceDir ?? null,
			presetWorkspaceDir: preset.workspaceDir ?? null,
			resolvedWorkspaceDir: workspaceDir ?? null,
		})

		const events: DomainEvent[] = [
			withSessionId(
				sessionId,
				sessionEvents.create('session_created', {
					presetId,
					...(workspaceDir ? { workspaceDir } : {}),
				}),
			),
		]

		// Seeded through the same event a runtime change uses, so there is one code
		// path and a forked/replayed session reconstructs the overrides for free.
		if (options?.overrides) {
			events.push(withSessionId(sessionId, sessionEvents.create('session_overrides_set', options.overrides)))
		}

		events.push(
			withSessionId(
				sessionId,
				agentEvents.create('agent_spawned', {
					agentId: orchestratorId,
					definitionName: ORCHESTRATOR_ROLE,
					parentId: null,
				}),
			),
		)

		// Spawn communicator if configured
		const hasCommunicator = !!preset.communicator

		if (hasCommunicator) {
			// First communicator gets seq 1
			const communicatorId = generateAgentId(COMMUNICATOR_ROLE, 1)
			events.push(withSessionId(
				sessionId,
				agentEvents.create('agent_spawned', {
					agentId: communicatorId,
					definitionName: COMMUNICATOR_ROLE,
					parentId: null,
				}),
			))

			// Link communicator to orchestrator
			events.push(withSessionId(
				sessionId,
				agentEvents.create('communicator_linked', {
					communicatorId,
					orchestratorId,
				}),
			))
		}

		if (this.sessions.has(sessionId)) return Err(SessionErrors.alreadyExists(String(sessionId)))
		const activity = new SessionRuntimeActivityController()
		let entry: SessionCacheEntry
		const creationPromise = Promise.resolve().then(async () => {
			if (await this.eventStore.exists(sessionId)) throw new SessionLoadError(SessionErrors.alreadyExists(String(sessionId)))
			await this.eventStore.appendBatch(sessionId, events)
			const plugins = this.buildPlugins(preset)
			const composedReducer = createApplyEvent(plugins)
			const state = reconstructSessionState(events, composedReducer)
			if (!state) throw new SessionLoadError(ValidationErrors.invalid('Failed to reconstruct session'))
			const store = new SessionStore(sessionId, this.eventStore, state, composedReducer)
			return this.createSessionInstance(store, preset, plugins, entry)
		})
		entry = {
			state: 'loading',
			promise: creationPromise,
			activity,
			lastAccessAt: performance.now(),
		}
		this.sessions.set(sessionId, entry)

		let session: Session
		try {
			session = await creationPromise
			if (this.sessions.get(sessionId) === entry && entry.state === 'loading') {
				entry.state = 'ready'
				entry.lastAccessAt = performance.now()
			}
		} catch (error) {
			if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId)
			entry.listenerCleanup?.()
			if (error instanceof SessionLoadError) return Err(error.domainError)
			throw error
		}

		this.logger.info('Session created', {
			sessionId,
			presetId,
			hasCommunicator,
		})

		return Ok(session)
	}

	/**
	 * Fork a session from a specific event index into a new independent session.
	 * The forked session gets a copy of all events up to the fork point.
	 */
	async forkSession(
		sourceSessionId: SessionId,
		eventIndex: number,
	): Promise<Result<Session, DomainError>> {
		if (this.shuttingDown) return Err(ValidationErrors.invalid('Session manager is shutting down'))
		// Load source events
		const sourceEvents = await this.eventStore.load(sourceSessionId)
		if (this.shuttingDown) return Err(ValidationErrors.invalid('Session manager is shutting down'))
		if (sourceEvents.length === 0) {
			return Err(SessionErrors.notFound(String(sourceSessionId)))
		}

		// Validate eventIndex range
		if (eventIndex < 0 || eventIndex >= sourceEvents.length) {
			return Err(ValidationErrors.invalid(`eventIndex ${eventIndex} out of range [0, ${sourceEvents.length - 1}]`))
		}

		// Get source preset
		const firstEvent = sourceEvents[0]
		if (!isSessionCreatedEvent(firstEvent)) {
			return Err(ValidationErrors.invalid('First event must be session_created'))
		}
		const preset = this.presets.get(firstEvent.presetId)
		if (!preset) {
			return Err(PresetErrors.notFound(firstEvent.presetId))
		}

		// Generate new session ID
		const newSessionId = generateSessionId()

		// Resolve workspace dir for the new session
		const rawWorkspaceDir = preset.workspaceDir
		const sourceWorkspaceDir = firstEvent.workspaceDir

		if (sourceWorkspaceDir && rawWorkspaceDir && !rawWorkspaceDir.includes('{sessionId}')) {
			return Err(
				ValidationErrors.invalid(
					'Cannot fork: preset workspaceDir has no {sessionId} placeholder, forked session would share the same workspace directory',
				),
			)
		}

		const newWorkspaceDir = rawWorkspaceDir?.replace('{sessionId}', String(newSessionId))

		// Rewrite events for the fork
		let forkedEvents = rewriteEventsForFork(sourceEvents, eventIndex, newSessionId, sourceSessionId)

		// Update workspaceDir in session_created if it changed
		if (newWorkspaceDir !== sourceWorkspaceDir) {
			forkedEvents = forkedEvents.map((event) => {
				if (event.type === 'session_created') {
					return { ...event, workspaceDir: newWorkspaceDir }
				}
				return event
			})
		}

		const activity = new SessionRuntimeActivityController()
		let entry: SessionCacheEntry
		const forkPromise = Promise.resolve().then(async () => {
			await this.eventStore.appendBatch(newSessionId, forkedEvents)
			const plugins = this.buildPlugins(preset)
			const composedReducer = createApplyEvent(plugins)
			const state = reconstructSessionState(forkedEvents, composedReducer)
			if (!state) throw new SessionLoadError(ValidationErrors.invalid('Failed to reconstruct forked session'))
			const store = new SessionStore(newSessionId, this.eventStore, state, composedReducer)
			const recoveryData = checkRecoveryNeeded(state)
			if (recoveryData) {
				await store.emit(withSessionId(
					newSessionId,
					sessionEvents.create('session_restarted', {
						resetAgentIds: recoveryData.resetAgentIds,
						clearedToolAgentIds: recoveryData.clearedToolAgentIds,
					}),
				))
			}
			return this.createSessionInstance(store, preset, plugins, entry)
		})
		entry = {
			state: 'loading',
			promise: forkPromise,
			activity,
			lastAccessAt: performance.now(),
		}
		this.sessions.set(newSessionId, entry)

		let session: Session
		try {
			session = await forkPromise
			if (this.sessions.get(newSessionId) === entry && entry.state === 'loading') entry.state = 'ready'
		} catch (error) {
			if (this.sessions.get(newSessionId) === entry) this.sessions.delete(newSessionId)
			entry.listenerCleanup?.()
			if (error instanceof SessionLoadError) return Err(error.domainError)
			throw error
		}

		// Check for pending agents
		session.checkPendingAgents()

		this.logger.info('Session forked', {
			sourceSessionId,
			newSessionId,
			eventIndex,
		})

		return Ok(session)
	}

	/**
	 * Get a session by ID - from cache or load from event store.
	 */
	async getSession(
		sessionId: SessionId,
	): Promise<Result<Session, DomainError>> {
		while (true) {
			if (this.shuttingDown) return Err(ValidationErrors.invalid('Session manager is shutting down'))
			let entry = this.sessions.get(sessionId)
			if (entry?.state === 'evicting') {
				await entry.unloadPromise
				continue
			}
			if (entry?.state === 'ready' && entry.activity.getSnapshot().state !== 'ready') {
				const session = await entry.promise
				await this.beginCacheEntryDisposal(sessionId, entry, session, 'disposed')
				continue
			}

			if (entry) {
				this.cacheHits++
				entry.lastAccessAt = performance.now()
			} else {
				this.cacheMisses++
				const activity = new SessionRuntimeActivityController()
				let loadingEntry: SessionCacheEntry
				const promise = Promise.resolve().then(() => this.loadSession(sessionId, loadingEntry))
				loadingEntry = {
					state: 'loading',
					activity,
					lastAccessAt: performance.now(),
					promise,
				}
				entry = loadingEntry
				this.sessions.set(sessionId, entry)
			}

			try {
				const session = await entry.promise
				if (this.sessions.get(sessionId) === entry && entry.state === 'loading') {
					if (session.state.status === 'closed') this.sessions.delete(sessionId)
					else {
						entry.state = 'ready'
						entry.lastAccessAt = performance.now()
					}
				}
				return Ok(session)
			} catch (error) {
				if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId)
				if (error instanceof SessionLoadError) return Err(error.domainError)
				throw error
			}
		}
	}

	/**
	 * Internal session loading - throws SessionLoadError on domain errors.
	 */
	private async loadSession(sessionId: SessionId, entry: SessionCacheEntry): Promise<Session> {
		// We need to peek at events first to determine the preset, so we can build plugins
		// and compose the reducer before loading the store
		const events = await this.eventStore.load(sessionId)
		if (events.length === 0) {
			throw new SessionLoadError(SessionErrors.notFound(String(sessionId)))
		}

		const firstEvent = events[0]
		if (!isSessionCreatedEvent(firstEvent)) {
			throw new SessionLoadError(SessionErrors.notFound(String(sessionId)))
		}

		const preset = this.presets.get(firstEvent.presetId)
		if (!preset) {
			throw new SessionLoadError(PresetErrors.notFound(firstEvent.presetId))
		}

		// Build plugins and composed reducer so plugin state slices are applied
		const plugins = this.buildPlugins(preset)
		const composedReducer = createApplyEvent(plugins)

		// Load store with composed reducer
		const store = await SessionStore.fromEvents(sessionId, this.eventStore, events, composedReducer)
		if (!store) {
			throw new SessionLoadError(SessionErrors.notFound(String(sessionId)))
		}

		const state = store.getState()

		// Don't cache closed sessions
		if (state.status === 'closed') {
			// Skip onSessionReady hooks — closed sessions are immutable, firing hooks
			// would emit events to a sealed event log on every read / restart.
			return await this.createSessionInstance(store, preset, plugins, entry, { skipReadyHooks: true })
		}

		// Check if recovery is needed after restart
		const recoveryData = checkRecoveryNeeded(state)
		if (recoveryData) {
			await store.emit(withSessionId(
				sessionId,
				sessionEvents.create('session_restarted', {
					resetAgentIds: recoveryData.resetAgentIds,
					clearedToolAgentIds: recoveryData.clearedToolAgentIds,
				}),
			))

			this.logger.info('Session recovered after restart', {
				sessionId,
				resetAgents: recoveryData.resetAgentIds.length,
				clearedToolAgents: recoveryData.clearedToolAgentIds.length,
			})
		}

		// Create session (auto-start services run via onSessionReady)
		const session = await this.createSessionInstance(store, preset, plugins, entry)

		// Check for pending agents
		session.checkPendingAgents()

		return session
	}

	/**
	 * Call a plugin method on a session.
	 * @param sessionId - Session ID
	 * @param method - Full method name (e.g., "services.start")
	 * @param input - Method input (must include sessionId field)
	 * @param agentId - Agent ID (optional — some methods don't operate on a specific agent)
	 */
	async callPluginMethod(
		sessionId: SessionId,
		method: string,
		input: unknown,
		agentId?: AgentId,
		caller?: CallerContext,
	): Promise<Result<unknown, DomainError>> {
		return this.withSessionLease(sessionId, `request:${method}`, (session) => (
			session.callPluginMethod(method, input, agentId, caller)
		))
	}

	/** Run an operation while atomically keeping the selected runtime resident. */
	async withSessionLease<T>(
		sessionId: SessionId,
		reason: string,
		operation: (session: Session) => Promise<Result<T, DomainError>>,
	): Promise<Result<T, DomainError>> {
		const acquired = await this.acquireSessionLease(sessionId, reason)
		if (!acquired.ok) return acquired
		try {
			return await operation(acquired.value.session)
		} finally {
			acquired.value.release()
		}
	}

	/** Atomically look up a runtime and acquire a caller-managed lease on it. */
	async acquireSessionLease(
		sessionId: SessionId,
		reason: string,
	): Promise<Result<AcquiredSessionLease, DomainError>> {
		while (true) {
			const sessionResult = await this.getSession(sessionId)
			if (!sessionResult.ok) return sessionResult

			const entry = this.sessions.get(sessionId)
			if (!entry) return Ok({ session: sessionResult.value, release: () => {} })
			const release = entry.activity.tryAcquire(reason)
			if (!release) {
				if (entry.unloadPromise) await entry.unloadPromise
				continue
			}

			entry.lastAccessAt = performance.now()
			let released = false
			return Ok({
				session: sessionResult.value,
				release: () => {
					if (released) return
					released = true
					entry.lastAccessAt = performance.now()
					release()
				},
			})
		}
	}

	/**
	 * Call a manager-level plugin method.
	 * These methods operate outside session context (e.g., session creation, listing).
	 */
	async callManagerMethod(
		method: string,
		input: unknown,
	): Promise<Result<unknown, DomainError>> {
		const methodDef = this.managerMethods.get(method)
		if (!methodDef) {
			return Err(ValidationErrors.invalid(`Unknown manager method: ${method}`))
		}

		const parsed = methodDef.input.safeParse(input)
		if (!parsed.success) {
			return Err(ValidationErrors.invalid(`Invalid input for ${method}: ${parsed.error.message}`))
		}

		const ctx: ManagerMethodContext = {
			sessionManager: this,
			eventStore: this.eventStore,
			presets: this.presets,
			logger: this.logger.child({ method }),
			llmLogger: this.llmLogger,
			platform: this.platform,
		}

		return await methodDef.handler(ctx, parsed.data)
	}

	/**
	 * Get all registered manager methods.
	 */
	getManagerMethods(): Map<string, { input: z4.ZodType; output: z4.ZodType }> {
		const result = new Map<string, { input: z4.ZodType; output: z4.ZodType }>()
		for (const [name, def] of this.managerMethods) {
			result.set(name, { input: def.input, output: def.output })
		}
		return result
	}

	/**
	 * Load all active sessions from event store (for restart recovery).
	 *
	 * Closed sessions are skipped — they have no runtime to restore. Loading them
	 * would trigger callSessionReadyHooks and emit events to an immutable session log,
	 * causing write amplification on every agent startup.
	 */
	async loadAllSessions(): Promise<void> {
		const sessionIds = await this.eventStore.listSessions()

		let loaded = 0
		let skipped = 0
		for (const sessionId of sessionIds) {
			try {
				const metadata = await this.eventStore.getMetadata(sessionId)
				if (metadata?.status === 'closed') {
					skipped++
					continue
				}
				await this.getSession(sessionId)
				loaded++
			} catch (error) {
				this.logger.error(
					'Failed to load session',
					error instanceof Error ? error : new Error(String(error)),
					{ sessionId },
				)
			}
		}

		this.logger.info('Loaded sessions', { loaded, skipped, total: sessionIds.length })
	}

	/**
	 * Get runtime stats including last activity timestamp and per-session metrics.
	 *
	 * Only open (non-closed) sessions contribute to activity metrics. Closed sessions
	 * are immutable artifacts — their event log timestamps must not be interpreted as
	 * "the sandbox is doing work", otherwise the worker alarm sees stale activity and
	 * keeps the sandbox alive forever.
	 */
	async getStats(): Promise<{
		sessionCount: number
		loadedSessionCount: number
		pendingAgents: number
		processingAgents: number
		lastActivityAt: number | null
		sessions: Array<{
			id: SessionId
			presetId: string
			status: string
			metrics: SessionStatsState
		}>
	}> {
		let pendingAgents = 0
		let processingAgents = 0
		let lastActivityAt: number | null = null

		const metadataResult = await this.eventStore.listSessionsWithMetadata()
		const openMetadata = metadataResult.sessions.filter((metadata) => metadata.status !== 'closed')

		// Wait for resident sessions, ignoring failed and evicting loads.
		const sessions = await Promise.all(
			Array.from(this.sessions.values())
				.filter((entry) => entry.state !== 'evicting')
				.map((entry) => entry.promise.catch(() => null)),
		)

		// Filter out closed sessions — they do not contribute to activity
		const openSessions = sessions.filter(
			(s): s is Session => s !== null && s.state.status !== 'closed',
		)

		for (const metadata of openMetadata) {
			if (metadata.lastActivityAt) {
				if (
					lastActivityAt === null
					|| metadata.lastActivityAt > lastActivityAt
				) {
					lastActivityAt = metadata.lastActivityAt
				}
			}
		}

		const sessionStats: Array<{
			id: SessionId
			presetId: string
			status: string
			metrics: SessionStatsState
		}> = []

		const loadedById = new Map(openSessions.map((session) => [session.id, session]))
		for (const session of openSessions) {
			for (const [agentId, agentState] of session.state.agents) {
				if (agentState.status === 'pending') {
					const hasUnconsumed = getAgentUnconsumedMailbox(selectMailboxState(session.state), agentId).length > 0
					if (hasUnconsumed) {
						pendingAgents++
					}
				}
				if (
					agentState.status === 'inferring'
					|| agentState.status === 'tool_exec'
				) {
					processingAgents++
				}
			}

		}

		for (const metadata of openMetadata) {
			const loaded = loadedById.get(metadata.sessionId)
			sessionStats.push({
				id: metadata.sessionId,
				presetId: metadata.presetId,
				status: loaded?.state.status ?? metadata.status,
				metrics: loaded ? selectSessionStats(loaded.state) : statsFromMetadata(metadata),
			})
		}

		return {
			sessionCount: openMetadata.length,
			loadedSessionCount: openSessions.length,
			pendingAgents,
			processingAgents,
			lastActivityAt,
			sessions: sessionStats,
		}
	}

	/**
	 * Shutdown - clean up all sessions.
	 */
	async shutdown(): Promise<void> {
		this.shuttingDown = true
		if (this.evictionSweepTimer) clearInterval(this.evictionSweepTimer)
		await Promise.all([...this.sessions].map(async ([sessionId, entry]) => {
			try {
				const session = await entry.promise
				await this.beginCacheEntryDisposal(sessionId, entry, session, 'shutdown')
			} catch (error) {
				entry.listenerCleanup?.()
				entry.listenerCleanup = undefined
				this.logger.error(
					'Failed to dispose session during shutdown',
					error instanceof Error ? error : new Error(String(error)),
					{ sessionId },
				)
			}
		}))
		this.sessions.clear()
		this.logger.info('SessionManager shutdown complete')
	}

	/** Narrow runtime-cache diagnostics for lifecycle tests and operational logs. */
	getRuntimeCacheStats(): {
		hits: number
		misses: number
		evictions: number
		loadedSessionCount: number
		sessions: Array<{
			id: SessionId
			state: SessionCacheEntry['state']
			lastAccessAt: number
			activeLeaseCount: number
			leaseReasons: Readonly<Record<string, number>>
		}>
	} {
		return {
			hits: this.cacheHits,
			misses: this.cacheMisses,
			evictions: this.cacheEvictions,
			loadedSessionCount: this.sessions.size,
			sessions: [...this.sessions].map(([id, entry]) => {
				const activity = entry.activity.getSnapshot()
				return {
					id,
					state: entry.state,
					lastAccessAt: Math.max(entry.lastAccessAt, activity.lastActivityAt),
					activeLeaseCount: activity.activeCount,
					leaseReasons: activity.reasons,
				}
			}),
		}
	}

	/**
	 * Sessions whose runtime is already resident and ready.
	 *
	 * Deliberately does not load, and does not refresh `lastAccessAt` — a passive
	 * reader must not keep a runtime alive or resurrect an evicted one. Use this
	 * over `getSession()` for read-only sweeps across sessions.
	 */
	async listResidentSessions(): Promise<Session[]> {
		const entries = [...this.sessions].filter(([, entry]) => entry.state === 'ready')
		const sessions = await Promise.all(entries.map(async ([sessionId, entry]) => {
			const session = await entry.promise.catch(() => null)
			// Re-check: the entry can start evicting while we await the resolved promise.
			if (!session || this.sessions.get(sessionId) !== entry || entry.state !== 'ready') return null
			return session
		}))
		return sessions.filter((session): session is Session => session !== null)
	}

	// ============================================================================
	// Private methods
	// ============================================================================

	/**
	 * Build ConfiguredPlugin[] for a session, in hook order.
	 *
	 * Iterates all system-registered plugins. For each:
	 * 1. Check if preset has explicit SessionPluginConfig → use that config
	 * 2. If not, try auto-deriving infrastructure config (agents, uploads, services)
	 * 3. If no config at all → call .create() with no args (void config)
	 * 4. Check isSessionEnabled — skip plugin if not enabled
	 *
	 * The result is sorted by each plugin's declared `.order()` — the precedence
	 * between plugins that both want the same hook, since most agent hooks stop
	 * at the first non-null result.
	 */
	private buildPlugins(preset: Preset): ConfiguredPlugin[] {
		// Build a lookup from preset Sessionplugins
		const presetConfigs = new Map<string, unknown>()
		for (const pluginConfig of preset.plugins ?? []) {
			presetConfigs.set(pluginConfig.pluginName, pluginConfig.config)
		}

		// Build infra-derived configs
		const infraConfigs = this.buildInfraConfigs(preset)

		const plugins: ConfiguredPlugin[] = []

		for (const pluginDef of this.systemPlugins) {
			// Determine config: merge infra (auto-derived) + preset explicit (overrides),
			// fall back to whichever exists, else no config (void).
			let config: unknown
			let hasConfig = false

			const presetConfig = presetConfigs.get(pluginDef.name)
			const infraConfig = infraConfigs.get(pluginDef.name)
			const isMergeable = (v: unknown): v is Record<string, unknown> =>
				typeof v === 'object' && v !== null && !Array.isArray(v)

			if (presetConfig !== undefined && infraConfig !== undefined && isMergeable(presetConfig) && isMergeable(infraConfig)) {
				config = { ...infraConfig, ...presetConfig }
				hasConfig = true
			} else if (presetConfig !== undefined) {
				config = presetConfig
				hasConfig = true
			} else if (infraConfig !== undefined) {
				config = infraConfig
				hasConfig = true
			}

			const configured = hasConfig
				? pluginDef.create(config)
				: pluginDef.create()

			// Check isSessionEnabled — skip plugin if not enabled
			if (configured.isSessionEnabled && !configured.isSessionEnabled({ pluginConfig: config })) {
				continue
			}

			plugins.push(configured)
		}

		// Process preset-only plugins (not registered as system plugins)
		const registeredNames = new Set(plugins.map(p => p.name))
		for (const pluginConfig of preset.plugins ?? []) {
			if (registeredNames.has(pluginConfig.pluginName)) continue

			const configured = pluginConfig.definition.create(pluginConfig.config)

			if (configured.isSessionEnabled && !configured.isSessionEnabled({ pluginConfig: pluginConfig.config })) {
				continue
			}

			plugins.push(configured)
			registeredNames.add(configured.name)
		}

		// Validate that all declared dependencies are registered
		for (const plugin of plugins) {
			for (const depName of plugin.dependencyNames) {
				if (!registeredNames.has(depName)) {
					throw new Error(
						`Plugin "${plugin.name}" declares dependency on "${depName}", but "${depName}" is not registered. Add it to systemPlugins.`,
					)
				}
			}
		}

		// Stable, so plugins that declare no order keep their registration order.
		return plugins.sort((a, b) => (a.order ?? DEFAULT_PLUGIN_ORDER) - (b.order ?? DEFAULT_PLUGIN_ORDER))
	}

	/**
	 * Build infrastructure-derived plugin configs from preset data.
	 * These are auto-derived for well-known plugins that need preset-level data.
	 */
	private buildInfraConfigs(preset: Preset): Map<string, unknown> {
		const configs = new Map<string, unknown>()

		// agents plugin — derive agentDefinitions from preset.agents
		const agentDefinitions = new Map<string, SpawnableAgentInfo>()
		for (const agentDef of preset.agents) {
			agentDefinitions.set(agentDef.name, {
				name: agentDef.name,
				inputSchema: agentDef.input,
			})
		}
		configs.set('agents', { agentDefinitions })

		// user-chat plugin — empty config
		configs.set('user-chat', {})

		// uploads plugin — needs dataFileStore and preprocessorRegistry from SessionManager
		configs.set('uploads', {
			dataFileStore: this.dataFileStore,
			preprocessorRegistry: this.preprocessorRegistry,
			archiveLimits: this.uploadArchiveLimits,
		})

		if (this.resourceArchiveLimits) {
			configs.set('resources', { archiveLimits: this.resourceArchiveLimits })
		}

		// services plugin — collect services from all agent definitions
		const allAgentConfigs = [preset.orchestrator, ...(preset.communicator ? [preset.communicator] : []), ...preset.agents]
		const servicesByType = new Map<string, ServiceConfig>()
		for (const agentConfig of allAgentConfigs) {
			for (const svc of agentConfig.services ?? []) {
				servicesByType.set(svc.type, svc)
			}
		}
		if (servicesByType.size > 0 && this.portPool) {
			configs.set('services', { services: [...servicesByType.values()], portPool: this.portPool, pidRegistry: this.pidRegistry })
		}

		return configs
	}

	/**
	 * Create a Session instance with all dependencies.
	 * Plugins must be pre-built via buildPlugins() so the composed reducer
	 * can be used for SessionStore before this method is called.
	 *
	 * @param opts.skipReadyHooks - Skip onSessionReady hooks. Used for closed sessions,
	 *   which must remain immutable: running hooks would emit session_handler_* events
	 *   to a sealed event log on every introspection / restart cycle.
	 */
	private async createSessionInstance(
		store: SessionStore,
		preset: Preset,
		plugins: ConfiguredPlugin[],
		entry: SessionCacheEntry,
		opts: { skipReadyHooks?: boolean } = {},
	): Promise<Session> {
		const sessionDir = this.getSessionDir(store.sessionId)
		const sessionLogger = new TeeLogger([
			this.logger.child({ sessionId: store.sessionId }),
			createSessionLogger(this.platform, String(store.sessionId), join(sessionDir, 'session.log')),
		])

		// Create session
		const session = new Session({
			store,
			preset,
			llmProvider: this.llmProvider,
			llmProviders: this.llmProviders,
			toolExecutor: this.toolExecutor,
			logger: sessionLogger,
			onUserOutput: this.onUserOutput,
			sessionDir,
			plugins,
			eventStore: this.eventStore,
			llmLogger: this.llmLogger,
			platform: this.platform,
			runtimeActivity: entry.activity,
			registerReopenedSession: (reopenedSession) => this.registerReopenedSession(reopenedSession, entry.activity),
		})

		// Only register cache eviction listener for active sessions (not closed)
		if (store.getState().status !== 'closed') {
			this.registerSessionEventListener(store.sessionId, store, session, entry)
		}

		// Ensure session and workspace directories exist before plugins run
		await this.platform.fs.mkdir(sessionDir, { recursive: true })
		const workspaceDir = store.getState().workspaceDir
		if (workspaceDir) {
			await this.platform.fs.mkdir(workspaceDir, { recursive: true })
		}

		try {
			// Safe for closed sessions — createContext is pure local setup, no event emit.
			await session.initPluginContexts()

			// Skipped for closed sessions to preserve event log immutability.
			if (!opts.skipReadyHooks) await session.callSessionReadyHooks()
		} catch (error) {
			await session.dispose('evicted')
			entry.listenerCleanup?.()
			entry.listenerCleanup = undefined
			throw error
		}

		return session
	}

	/**
	 * Collect manager methods from all system plugin definitions.
	 */
	private collectManagerMethods(): Map<string, {
		input: z4.ZodType
		output: z4.ZodType
		handler: (ctx: ManagerMethodContext, input: unknown) => Promise<Result<unknown, DomainError>>
	}> {
		const methods = new Map<string, {
			input: z4.ZodType
			output: z4.ZodType
			handler: (ctx: ManagerMethodContext, input: unknown) => Promise<Result<unknown, DomainError>>
		}>()

		for (const pluginDef of this.systemPlugins) {
			for (const [methodName, methodDef] of Object.entries(pluginDef.managerMethods)) {
				methods.set(`${pluginDef.name}.${methodName}`, methodDef)
			}
		}

		return methods
	}

	/**
	 * Register event listener on a session's store for automatic cache eviction.
	 * When session_closed or session_reopened events fire, the session is evicted
	 * so next getSession() triggers a full load with recovery.
	 *
	 * Cleans up any previous listener for this sessionId (from a prior load)
	 * to prevent duplicate listeners firing on old stores.
	 */
	private registerSessionEventListener(sessionId: SessionId, store: SessionStore, session: Session, entry: SessionCacheEntry): void {
		entry.listenerCleanup?.()
		const unsubscribe = store.onEvent((event) => {
			if (event.type === 'session_closed') {
				if (this.sessions.get(sessionId) === entry) this.beginCacheEntryDisposal(sessionId, entry, session, 'closed')
				else void session.dispose('closed')
			} else if (event.type === 'session_reopened') {
				if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId)
				unsubscribe()
				entry.listenerCleanup = undefined
			}
		})
		entry.listenerCleanup = unsubscribe
	}

	private registerReopenedSession(
		session: Session,
		activity: SessionRuntimeActivityController,
	): Result<SessionReopenRegistration | undefined, DomainError> {
		if (this.shuttingDown) return Err(ValidationErrors.invalid('Session manager is shutting down'))
		if (activity.getSnapshot().state !== 'ready') return Ok(undefined)
		if (this.sessions.has(session.id)) return Err(SessionErrors.alreadyExists(String(session.id)))

		const deferred = Promise.withResolvers<Session>()
		void deferred.promise.catch(() => {})
		const entry: SessionCacheEntry = {
			state: 'loading',
			promise: deferred.promise,
			activity,
			lastAccessAt: performance.now(),
		}
		this.sessions.set(session.id, entry)

		return Ok({
			complete: async () => {
				if (this.sessions.get(session.id) !== entry) {
					throw new Error(`Reopened session lost cache ownership: ${session.id}`)
				}
				this.registerSessionEventListener(session.id, session.store, session, entry)
				try {
					await session.callSessionReadyHooks()
					session.checkPendingAgents()
					if (this.sessions.get(session.id) !== entry || entry.state !== 'loading' || activity.getSnapshot().state !== 'ready') {
						throw new Error(`Reopened session became unavailable during ready hooks: ${session.id}`)
					}
					entry.state = 'ready'
					entry.lastAccessAt = performance.now()
					deferred.resolve(session)
				} catch (error) {
					if (this.sessions.get(session.id) === entry) this.sessions.delete(session.id)
					entry.listenerCleanup?.()
					entry.listenerCleanup = undefined
					deferred.reject(error)
					await session.dispose('evicted')
					throw error
				}
			},
			abort: (error) => {
				if (this.sessions.get(session.id) === entry) this.sessions.delete(session.id)
				entry.listenerCleanup?.()
				entry.listenerCleanup = undefined
				deferred.reject(error)
			},
		})
	}

	private async evictIdleSessions(): Promise<void> {
		if (this.sessionIdleTimeoutMs === 0) return
		const now = performance.now()
		const disposals: Promise<void>[] = []
		for (const [sessionId, entry] of this.sessions) {
			if (entry.state !== 'ready') continue
			const activity = entry.activity.getSnapshot()
			if (now - Math.max(entry.lastAccessAt, activity.lastActivityAt) < this.sessionIdleTimeoutMs) continue
			if (!entry.activity.tryBeginUnload()) continue
			const session = await entry.promise
			disposals.push(this.beginCacheEntryDisposal(sessionId, entry, session, 'idle'))
		}
		await Promise.all(disposals)
	}

	private beginCacheEntryDisposal(
		sessionId: SessionId,
		entry: SessionCacheEntry,
		session: Session,
		reason: RuntimeDisposalCause,
	): Promise<void> {
		if (entry.unloadPromise) return entry.unloadPromise
		entry.state = 'evicting'
		entry.activity.beginForcedUnload()
		entry.unloadPromise = session.dispose(RUNTIME_DISPOSAL_CLOSE_REASON[reason])
			.catch((error) => {
				this.logger.error(
					'Failed to dispose session runtime',
					error instanceof Error ? error : new Error(String(error)),
					{ sessionId, reason },
				)
			})
			.finally(() => {
				if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId)
				entry.listenerCleanup?.()
				entry.listenerCleanup = undefined
				if (reason === 'idle') this.cacheEvictions++
				this.logger.debug('Session runtime evicted', { sessionId, reason })
			})
		return entry.unloadPromise
	}

	private getSessionDir(sessionId: SessionId): string {
		return join(this.basePath, 'sessions', String(sessionId))
	}
}

function statsFromMetadata(metadata: SessionMetadata): SessionStatsState {
	return {
		totalTokens: metadata.metrics?.totalTokens ?? 0,
		promptTokens: metadata.metrics?.inputTokens ?? 0,
		completionTokens: metadata.metrics?.outputTokens ?? 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalCost: metadata.metrics?.totalCost ?? 0,
		llmCalls: metadata.metrics?.totalLLMCalls ?? 0,
		llmErrors: 0,
		toolCalls: metadata.metrics?.totalToolCalls ?? 0,
		toolErrors: 0,
		userMessages: metadata.metrics?.totalMessages ?? 0,
		compactions: 0,
		agentCount: metadata.metrics?.totalAgents ?? 0,
		firstEventAt: metadata.createdAt,
		lastEventAt: metadata.lastActivityAt,
		byProvider: {},
		byAgent: {},
	}
}
