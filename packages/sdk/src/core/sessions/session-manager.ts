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
import type { AgentId } from '~/core/agents/schema.js'
import { generateAgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { type DomainError, PresetErrors, SessionErrors, ValidationErrors } from '~/core/errors.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { DomainEvent } from '~/core/events/types.js'
import type { FileStore } from '~/core/file-store/types.js'
import type { LLMLogger } from '~/core/llm/logger.js'
import type { LLMProvider } from '~/core/llm/provider.js'
import type { CallerContext, ConfiguredPlugin, ManagerMethodContext, PluginDefinition } from '~/core/plugins/plugin-builder.js'
import type { Preset } from '~/core/preset/index.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { generateSessionId } from '~/core/sessions/schema.js'
import type { SessionCreatedEvent } from '~/core/sessions/state.js'
import { checkRecoveryNeeded, isSessionCreatedEvent, reconstructSessionState, sessionEvents } from '~/core/sessions/state.js'
import type { ToolExecutor } from '~/core/tools'
import { FileLogger } from '~/lib/logger/file.js'
import type { Logger } from '~/lib/logger/logger.js'
import { TeeLogger } from '~/lib/logger/tee.js'
import type { Platform } from '~/platform/index.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { SpawnableAgentInfo } from '~/plugins/agents/index.js'
import { getAgentUnconsumedMailbox, selectMailboxState } from '~/plugins/mailbox/query.js'
import type { PortPool } from '~/plugins/services/port-pool.js'
import type { ServiceConfig } from '~/plugins/services/schema.js'
import { selectSessionStats, type SessionStatsState } from '~/plugins/session-stats/index.js'
import type { PreprocessorRegistry } from '~/plugins/uploads/preprocessor.js'
import { EventStore } from '../events/event-store.js'
import { createApplyEvent } from './apply-event.js'
import { rewriteEventsForFork } from './fork-utils.js'
import { SessionStore } from './session-store.js'
import { Session, type UserOutputCallback } from './session.js'

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
	llmLogger?: LLMLogger
	portPool?: PortPool
	/** Host-environment adapters (filesystem, process). */
	platform: Platform
	systemPlugins?: readonly PluginDefinition<string, any, any, any, any>[]
}

/**
 * SessionManager manages session lifecycle and caching.
 */
export class SessionManager {
	private readonly sessions = new Map<SessionId, Promise<Session>>()
	/** Unsubscribe functions for session event listeners, keyed by sessionId */
	private readonly sessionListenerCleanup = new Map<SessionId, () => void>()
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
	private readonly llmLogger?: LLMLogger
	private readonly portPool?: PortPool
	private readonly platform: Platform
	private readonly systemPlugins: readonly PluginDefinition<string, any, any, any, any>[]

	constructor(options: SessionManagerOptions) {
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
		this.llmLogger = options.llmLogger
		this.portPool = options.portPool
		this.platform = options.platform
		this.systemPlugins = options.systemPlugins ?? []
		this.managerMethods = this.collectManagerMethods()
	}

	/** Expose platform adapters (used by Session for building contexts). */
	getPlatform(): Platform {
		return this.platform
	}

	/**
	 * Create a new session with the given preset.
	 */
	async createSession(
		presetId: string,
		options?: { workspaceDir?: string; sessionId?: string },
	): Promise<Result<Session, DomainError>> {
		const preset = this.presets.get(presetId)
		if (!preset) {
			return Err(PresetErrors.notFound(presetId))
		}

		const sessionId = options?.sessionId ? (options.sessionId as any) : generateSessionId()
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
			withSessionId(
				sessionId,
				agentEvents.create('agent_spawned', {
					agentId: orchestratorId,
					definitionName: ORCHESTRATOR_ROLE,
					parentId: null,
				}),
			),
		]

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

		// Write events to event store
		await this.eventStore.appendBatch(sessionId, events)

		// Build plugins and composed reducer so plugin state slices are applied
		const plugins = this.buildPlugins(preset)
		const composedReducer = createApplyEvent(plugins)

		// Reconstruct state with composed reducer (includes plugin state slices)
		const state = reconstructSessionState(events, composedReducer)
		if (!state) {
			return Err(ValidationErrors.invalid('Failed to reconstruct session'))
		}

		// Create store and session (initPluginContexts + onSessionReady hooks run inside)
		const store = new SessionStore(sessionId, this.eventStore, state, composedReducer)
		const session = await this.createSessionInstance(store, preset, plugins)

		// Cache session (wrap in resolved promise for consistency)
		this.sessions.set(sessionId, Promise.resolve(session))

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
		// Load source events
		const sourceEvents = await this.eventStore.load(sourceSessionId)
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

		// Write forked events to event store
		await this.eventStore.appendBatch(newSessionId, forkedEvents)

		// Build plugins and composed reducer so plugin state slices are applied
		const plugins = this.buildPlugins(preset)
		const composedReducer = createApplyEvent(plugins)

		// Reconstruct state with composed reducer (includes plugin state slices)
		const state = reconstructSessionState(forkedEvents, composedReducer)
		if (!state) {
			return Err(ValidationErrors.invalid('Failed to reconstruct forked session'))
		}

		// Create store
		const store = new SessionStore(newSessionId, this.eventStore, state, composedReducer)

		// Normalize stuck agents via session_restarted event
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

		// Create session instance (auto-start services run via onSessionReady)
		const session = await this.createSessionInstance(store, preset, plugins)

		// Check for pending agents
		session.checkPendingAgents()

		// Cache session
		this.sessions.set(newSessionId, Promise.resolve(session))

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
		// Check cache first
		const cached = this.sessions.get(sessionId)
		if (cached) {
			try {
				return Ok(await cached)
			} catch (error) {
				// Previous load failed, remove from cache and try again
				this.sessions.delete(sessionId)
				if (error instanceof SessionLoadError) {
					return Err(error.domainError)
				}
				throw error
			}
		}

		// Store promise immediately to prevent concurrent loads
		const loadPromise = this.loadSession(sessionId)
		this.sessions.set(sessionId, loadPromise)

		try {
			return Ok(await loadPromise)
		} catch (error) {
			this.sessions.delete(sessionId)
			if (error instanceof SessionLoadError) {
				return Err(error.domainError)
			}
			throw error
		}
	}

	/**
	 * Internal session loading - throws SessionLoadError on domain errors.
	 */
	private async loadSession(sessionId: SessionId): Promise<Session> {
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
		const store = await SessionStore.load(sessionId, this.eventStore, composedReducer)
		if (!store) {
			throw new SessionLoadError(SessionErrors.notFound(String(sessionId)))
		}

		const state = store.getState()

		// Don't cache closed sessions
		if (state.status === 'closed') {
			// Remove from cache since we don't cache closed sessions
			this.sessions.delete(sessionId)
			// Skip onSessionReady hooks — closed sessions are immutable, firing hooks
			// would emit events to a sealed event log on every read / restart.
			return await this.createSessionInstance(store, preset, plugins, { skipReadyHooks: true })
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
		const session = await this.createSessionInstance(store, preset, plugins)

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
		const sessionResult = await this.getSession(sessionId)
		if (!sessionResult.ok) return sessionResult

		return sessionResult.value.callPluginMethod(method, input, agentId, caller)
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

		// Wait for all sessions, ignoring failures
		const sessions = await Promise.all(
			Array.from(this.sessions.values()).map((p) => p.catch(() => null)),
		)

		// Filter out closed sessions — they do not contribute to activity
		const openSessions = sessions.filter(
			(s): s is Session => s !== null && s.state.status !== 'closed',
		)

		// Fetch metadata only for open sessions
		const metadataResults = await Promise.all(
			openSessions.map((s) => this.eventStore.getMetadata(s.state.id).catch(() => null)),
		)

		for (const metadata of metadataResults) {
			if (metadata?.lastActivityAt) {
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

			sessionStats.push({
				id: session.state.id,
				presetId: session.state.presetId,
				status: session.state.status,
				metrics: selectSessionStats(session.state),
			})
		}

		return {
			sessionCount: openSessions.length,
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
		// Wait for all sessions, ignoring failures
		const sessions = await Promise.all(
			Array.from(this.sessions.values()).map((p) => p.catch(() => null)),
		)

		for (const session of sessions) {
			if (session) {
				session.shutdown()
			}
		}
		this.sessions.clear()
		for (const cleanup of this.sessionListenerCleanup.values()) {
			cleanup()
		}
		this.sessionListenerCleanup.clear()
		this.logger.info('SessionManager shutdown complete')
	}

	// ============================================================================
	// Private methods
	// ============================================================================

	/**
	 * Build ConfiguredPlugin[] for a session.
	 *
	 * Iterates all system-registered plugins. For each:
	 * 1. Check if preset has explicit SessionPluginConfig → use that config
	 * 2. If not, try auto-deriving infrastructure config (agents, uploads, services)
	 * 3. If no config at all → call .create() with no args (void config)
	 * 4. Check isSessionEnabled — skip plugin if not enabled
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
			// Determine config: preset explicit > infra auto-derived > no config (void)
			let config: unknown
			let hasConfig = false

			if (presetConfigs.has(pluginDef.name)) {
				config = presetConfigs.get(pluginDef.name)
				hasConfig = true
			} else if (infraConfigs.has(pluginDef.name)) {
				config = infraConfigs.get(pluginDef.name)
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

		return plugins
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
		})

		// services plugin — collect services from all agent definitions
		const allAgentConfigs = [preset.orchestrator, ...(preset.communicator ? [preset.communicator] : []), ...preset.agents]
		const servicesByType = new Map<string, ServiceConfig>()
		for (const agentConfig of allAgentConfigs) {
			for (const svc of agentConfig.services ?? []) {
				servicesByType.set(svc.type, svc)
			}
		}
		if (servicesByType.size > 0 && this.portPool) {
			configs.set('services', { services: [...servicesByType.values()], portPool: this.portPool })
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
		opts: { skipReadyHooks?: boolean } = {},
	): Promise<Session> {
		// Only register cache eviction listener for active sessions (not closed)
		if (store.getState().status !== 'closed') {
			this.registerSessionEventListener(store.sessionId, store)
		}

		const sessionDir = this.getSessionDir(store.sessionId)
		const sessionLogger = new TeeLogger([
			this.logger.child({ sessionId: store.sessionId }),
			new FileLogger(join(sessionDir, 'session.log'), this.platform.fs, { sessionId: String(store.sessionId) }),
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
		})

		// Ensure session and workspace directories exist before plugins run
		await this.platform.fs.mkdir(sessionDir, { recursive: true })
		const workspaceDir = store.getState().workspaceDir
		if (workspaceDir) {
			await this.platform.fs.mkdir(workspaceDir, { recursive: true })
		}

		// Initialize plugin contexts (calls createContext for each plugin).
		// Safe for closed sessions — createContext is pure local setup, no event emit.
		await session.initPluginContexts()

		// Call onSessionReady hooks with full context.
		// Skipped for closed sessions to preserve event log immutability.
		if (!opts.skipReadyHooks) {
			await session.callSessionReadyHooks()
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
	private registerSessionEventListener(sessionId: SessionId, store: SessionStore): void {
		const prevCleanup = this.sessionListenerCleanup.get(sessionId)
		if (prevCleanup) prevCleanup()

		const unsubscribe = store.onEvent((event) => {
			if (event.type === 'session_closed' || event.type === 'session_reopened') {
				this.sessions.delete(sessionId)
				this.sessionListenerCleanup.delete(sessionId)
			}
		})
		this.sessionListenerCleanup.set(sessionId, unsubscribe)
	}

	private getSessionDir(sessionId: SessionId): string {
		return join(this.basePath, 'sessions', String(sessionId))
	}
}
