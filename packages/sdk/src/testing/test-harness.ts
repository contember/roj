import type { AgentId } from '~/core/agents/schema.js'
import type { DomainError } from '~/core/errors.js'
import { MemoryEventStore } from '~/core/events/memory.js'
import type { DomainEvent } from '~/core/events/types.js'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import type { LLMLogger } from '~/core/llm/logger.js'
import { LoggingLLMProvider } from '~/core/llm/logging-provider.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { MockInferenceHandler } from '~/core/llm/mock.js'
import type { PluginDefinition, PluginNotification } from '~/core/plugins/plugin-builder.js'
import type { Preset } from '~/core/preset/index.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { SessionManager } from '~/core/sessions/session-manager.js'
import type { Session } from '~/core/sessions/session.js'
import type { SessionState } from '~/core/sessions/state.js'
import { ToolExecutor } from '~/core/tools/executor.js'
import { silentLogger } from '~/lib/logger/logger.js'
import { createNodePlatform } from './node-platform.js'
import type { Result } from '~/lib/utils/result.js'
import { agentsPlugin } from '~/plugins/agents/plugin.js'
import { filesystemPlugin } from '~/plugins/filesystem/index.js'
import { llmDebugPlugin } from '~/plugins/llm-debug/plugin.js'
import { logsPlugin } from '~/plugins/logs/index.js'
import { mailboxPlugin } from '~/plugins/mailbox/plugin.js'
import { presetsPlugin, sessionLifecyclePlugin } from '~/plugins/session-lifecycle/index.js'
import { uploadsPlugin } from '~/plugins/uploads/plugin.js'
import { userChatPlugin } from '~/plugins/user-chat/plugin.js'
import { NotificationCollector } from './notification-collector.js'
import { waitForAllAgentsIdle } from './wait-helpers.js'

/**
 * Default system plugins for testing — same as builtinPlugins in bootstrap.ts.
 */
const defaultSystemPlugins: readonly PluginDefinition<string, any, any, any, any>[] = [
	sessionLifecyclePlugin,
	presetsPlugin,
	mailboxPlugin,
	agentsPlugin,
	userChatPlugin,
	uploadsPlugin,
	llmDebugPlugin,
	filesystemPlugin,
	logsPlugin,
]

/**
 * TestHarness — boots a real SessionManager with MemoryEventStore,
 * MockLLMProvider, and in-memory notification collection.
 *
 * Enables full-flow integration tests without external dependencies.
 */
export class TestHarness {
	readonly eventStore: MemoryEventStore
	readonly llmProvider: MockLLMProvider
	readonly notifications: NotificationCollector
	readonly sessionManager: SessionManager

	constructor(options: {
		presets: Preset[]
		llmProvider?: MockLLMProvider
		mockHandler?: MockInferenceHandler
		/** Additional system plugins to register (merged with built-in defaults) */
		systemPlugins?: readonly PluginDefinition<string, any, any, any, any>[]
		/** Optional LLM logger — when provided, wraps the mock provider with LoggingLLMProvider */
		llmLogger?: LLMLogger
		/** Optional pre-existing event store — lets multiple harnesses share persisted state (simulates server restart) */
		eventStore?: MemoryEventStore
	}) {
		this.eventStore = options.eventStore ?? new MemoryEventStore()

		if (options.llmProvider) {
			this.llmProvider = options.llmProvider
		} else if (options.mockHandler) {
			this.llmProvider = new MockLLMProvider(options.mockHandler)
		} else {
			// Default: echo back content with no tool calls
			this.llmProvider = MockLLMProvider.withFixedResponse({
				content: 'Mock response',
				toolCalls: [],
			})
		}

		this.notifications = new NotificationCollector()

		const presetsMap = new Map(options.presets.map((p) => [p.id, p]))

		// Override debounceMs: 0 on all preset agents for instant processing
		for (const preset of presetsMap.values()) {
			preset.orchestrator.debounceMs = 0
			if (preset.communicator) {
				preset.communicator.debounceMs = 0
			}
			for (const agent of preset.agents) {
				agent.debounceMs = 0
			}
		}

		const basePath = `/tmp/roj-test-${Math.random().toString(36).slice(2)}`
		const toolExecutor = new ToolExecutor(silentLogger)
		const platform = createNodePlatform()
		const dataFileStore = new SessionFileStore(basePath, undefined, false, platform.fs, 'session')

		// When llmLogger is provided, wrap the mock provider so calls get logged
		const effectiveProvider = options.llmLogger
			? new LoggingLLMProvider(this.llmProvider, options.llmLogger)
			: this.llmProvider

		this.sessionManager = new SessionManager({
			eventStore: this.eventStore,
			llmProvider: effectiveProvider,
			toolExecutor,
			presets: presetsMap,
			logger: silentLogger,
			basePath,
			dataFileStore,
			onUserOutput: (n: PluginNotification) => this.notifications.push(n),
			llmLogger: options.llmLogger,
			platform,
			systemPlugins: [...defaultSystemPlugins, ...(options.systemPlugins ?? [])],
		})
	}

	/**
	 * Create a session and return a TestSession wrapper.
	 */
	async createSession(presetId: string): Promise<TestSession> {
		const result = await this.sessionManager.createSession(presetId)
		if (!result.ok) {
			throw new Error(`Failed to create session: ${result.error.type} — ${result.error.message}`)
		}
		return new TestSession(result.value, this)
	}

	/**
	 * Open an existing session from the event store (replays events, runs onSessionReady hooks).
	 * Used to simulate server restart by pairing with another harness over the same eventStore.
	 */
	async openSession(sessionId: SessionId): Promise<TestSession> {
		const result = await this.sessionManager.getSession(sessionId)
		if (!result.ok) {
			throw new Error(`Failed to open session: ${result.error.type} — ${result.error.message}`)
		}
		return new TestSession(result.value, this)
	}

	/**
	 * Shutdown all sessions.
	 */
	async shutdown(): Promise<void> {
		await this.sessionManager.shutdown()
	}
}

/**
 * TestSession — convenience wrapper around Session for integration tests.
 */
export class TestSession {
	readonly sessionId: SessionId

	constructor(
		private readonly session: Session,
		private readonly harness: TestHarness,
	) {
		this.sessionId = session.id
	}

	/**
	 * Send a message to the entry agent (communicator or orchestrator).
	 */
	async sendMessage(content: string): Promise<void> {
		const entryAgentId = this.session.getEntryAgentId()
		if (!entryAgentId) {
			throw new Error('No entry agent found')
		}
		await this.sendMessageToAgent(entryAgentId, content)
	}

	/**
	 * Send a message to a specific agent.
	 */
	async sendMessageToAgent(agentId: AgentId, content: string): Promise<void> {
		const result = await this.session.callPluginMethod('user-chat.sendMessage', {
			sessionId: String(this.sessionId),
			content,
			agentId: String(agentId),
		})
		if (!result.ok) {
			throw new Error(`sendMessage failed: ${result.error.type} — ${result.error.message}`)
		}
	}

	/**
	 * Wait for all agents to become idle.
	 */
	async waitForIdle(opts?: { timeoutMs?: number }): Promise<void> {
		await waitForAllAgentsIdle(this.session, opts)
	}

	/**
	 * Send a message and wait for all agents to become idle.
	 */
	async sendAndWaitForIdle(content: string, opts?: { timeoutMs?: number }): Promise<void> {
		await this.sendMessage(content)
		await this.waitForIdle(opts)
	}

	/**
	 * Get all events from the event store for this session.
	 */
	async getEvents(): Promise<DomainEvent[]> {
		return this.harness.eventStore.load(this.sessionId)
	}

	/**
	 * Get events filtered by type.
	 * When called with an EventsFactory, returns fully typed events.
	 */
	async getEventsByType(type: string): Promise<DomainEvent[]>
	async getEventsByType<TEventsMap extends Record<string, DomainEvent>, K extends string & keyof TEventsMap>(
		factory: { Events: TEventsMap },
		type: K,
	): Promise<TEventsMap[K][]>
	async getEventsByType(factoryOrType: string | { Events: Record<string, DomainEvent> }, maybeType?: string): Promise<DomainEvent[]> {
		const type = typeof factoryOrType === 'string' ? factoryOrType : maybeType!
		return this.harness.eventStore.getEventsByType(this.sessionId, type)
	}

	/**
	 * Get notifications for this session.
	 */
	getNotifications(): PluginNotification[] {
		return this.harness.notifications.getAll()
	}

	/**
	 * Get the current session state.
	 */
	get state(): SessionState {
		return this.session.state
	}

	/**
	 * Get the entry agent ID.
	 */
	getEntryAgentId(): AgentId | null {
		return this.session.getEntryAgentId()
	}

	/**
	 * Close the session.
	 */
	async close(): Promise<void> {
		const result = await this.session.close()
		if (!result.ok) {
			throw new Error(`close failed: ${result.error.type} — ${result.error.message}`)
		}
	}

	/**
	 * Call a plugin method on the underlying session.
	 */
	async callPluginMethod(method: string, input: unknown): Promise<Result<unknown, DomainError>> {
		return this.session.callPluginMethod(method, input)
	}

	/**
	 * Answer a user-chat question (convenience wrapper around callPluginMethod).
	 */
	async answerQuestion(agentId: AgentId, questionId: string, answer: unknown): Promise<void> {
		const result = await this.session.callPluginMethod('user-chat.answerQuestion', {
			agentId: String(agentId),
			questionId,
			answer,
		})
		if (!result.ok) {
			throw new Error(`answerQuestion failed: ${result.error.type} — ${result.error.message}`)
		}
	}
}
