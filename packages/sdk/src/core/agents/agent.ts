/**
 * Agent - OOP wrapper for agent orchestration.
 *
 * Responsibilities:
 * - Process mailbox (inference + tool execution loop)
 * - Embedded scheduling with debounce
 * - Spawn child agents
 */

import z from 'zod/v4'
import { DebounceCallback } from '~/core/agents/debounce.js'
import type { AgentId } from '~/core/agents/schema.js'
import type { AgentState, HandlerResult } from '~/core/agents/state.js'
import { agentEvents } from '~/core/agents/state.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { FileStore } from '~/core/file-store/types.js'
import { applyCacheBreakpoint } from '~/core/llm/cache-breakpoints.js'
import type { ToolResultContent } from '~/core/llm/llm-log-types.js'
import type { InferenceRequest, LLMMessage, LLMProvider } from '~/core/llm/provider.js'
import { LLMCallId, ModelId } from '~/core/llm/schema.js'
import type { LLMResponse } from '~/core/llm/state.js'
import { llmEvents } from '~/core/llm/state.js'
import type {
	AfterInferenceResult,
	AfterToolCallResult,
	BeforeInferenceResult,
	BeforeToolCallResult,
	HandlerName,
	OnCompleteResult,
	OnErrorResult,
	OnStartResult,
} from '~/core/plugins/hook-types.js'
import type {
	AgentPluginConfig,
	BasePluginHookContext,
	ConfiguredPlugin,
	PluginMethodCaller,
	PluginNotification,
} from '~/core/plugins/plugin-builder.js'
import { buildPluginDeps } from '~/core/plugins/plugin-builder.js'
import type { ToolContext } from '~/core/tools/context.js'
import type { ToolDefinition } from '~/core/tools/definition.js'
import type { ToolCall } from '~/core/tools/schema.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { toolEvents } from '~/core/tools/state.js'
import { getAgentUnconsumedMailbox, selectMailboxState } from '~/plugins/mailbox/query.js'
import { AGENT_BASE_BRIEFING } from '~/prompts/base.js'
import { buildEnvironmentSection } from '~/prompts/builder.js'
import type { Logger } from '../../lib/logger/logger.js'
import type { SessionContext } from '../sessions/context.js'
import type { SessionStore } from '../sessions/session-store.js'
import type { SessionState } from '../sessions/state.js'
import type { SessionEnvironment, ToolExecutor } from '../tools'
import type { AgentContext } from './context.js'
import { sanitizeLLMResponse } from './response-sanitizer.js'
import { withLLMRetry } from './retry.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Agent configuration - includes both behavior and debounce settings.
 */
export interface AgentConfig<TInput = unknown> {
	systemPrompt: string
	model: ModelId
	spawnableAgents: string[]
	// ToolDefinition<any> required: ToolDefinition is contravariant in TInput,
	// so ToolDefinition<SpecificInput> is not assignable to ToolDefinition<unknown>
	/** Preset-level static tools (merged with plugin tools at runtime) */
	tools?: ToolDefinition<any>[]
	/** Debounce time in ms before processing agent mailbox. Default: 500ms */
	debounceMs?: number
	/** Optional callback to determine when to process */
	debounceCallback?: DebounceCallback
	/** Interval in ms for checking debounce callback (default: 100) */
	checkIntervalMs?: number
	/** Optional Zod schema for typed agent input validation */
	input?: z.ZodType<TInput>
	/** Per-plugin agent-level configs */
	plugins?: AgentPluginConfig[]
}

/**
 * Dependencies for creating an Agent.
 */
export interface AgentDependencies {
	id: AgentId
	sessionContext: SessionContext
	store: SessionStore
	llmProvider: LLMProvider
	/** Named provider instances, passed to InferenceContext for middleware routing */
	llmProviders?: ReadonlyMap<string, LLMProvider>
	toolExecutor: ToolExecutor
	logger: Logger
	config: AgentConfig
	plugins: ConfiguredPlugin[]
	/** Session environment directories for tool context */
	environment: SessionEnvironment
	/** FileStore for resolving agent-visible file:// paths (used by LLM provider) */
	fileStore: FileStore
	/** Plugin contexts created by session-level initPluginContexts(), keyed by plugin name */
	pluginContexts?: ReadonlyMap<string, unknown>
	/** Callback for sending plugin notifications directly to transport */
	sendNotification?: (notification: PluginNotification) => void
	/** Callback for resolving cross-plugin method calls (delegates to session) */
	pluginMethodCaller?: PluginMethodCaller
	/** Callback for scheduling this agent for processing */
	schedule?: () => void
}

// ============================================================================
// Agent
// ============================================================================

/**
 * Agent handles mailbox processing, inference, and tool execution.
 *
 * Features:
 * - Debounced processing (timer or callback-based)
 * - LLM inference with retry
 * - Context compaction
 * - Tool execution
 */
export class Agent {
	readonly id: AgentId
	private readonly config: AgentConfig
	private readonly sessionContext: SessionContext
	private readonly store: SessionStore
	private readonly logger: Logger
	private readonly llmProvider: LLMProvider
	private readonly llmProviders: ReadonlyMap<string, LLMProvider>
	private readonly toolExecutor: ToolExecutor
	private readonly plugins: ConfiguredPlugin[]
	private readonly environment: SessionEnvironment
	private readonly fileStore: FileStore
	private readonly pluginContexts: ReadonlyMap<string, unknown>
	private readonly sendNotification?: (notification: PluginNotification) => void
	private readonly pluginMethodCaller?: PluginMethodCaller
	private readonly scheduleCallback?: () => void

	/** Merged tools map: config tools + plugin tools (plugins override). Rebuilt each processing cycle. */
	private tools: Map<string, ToolDefinition>

	// Scheduler state (embedded)
	private debounceTimer?: ReturnType<typeof setTimeout>
	private processing = false
	private scheduled = false
	private pendingReschedule = false
	private readonly abortController = new AbortController()

	/** Track conversation turn number for handler context */
	private turnNumber = 0

	constructor(deps: AgentDependencies) {
		this.id = deps.id
		this.config = deps.config
		this.sessionContext = deps.sessionContext
		this.store = deps.store
		this.logger = deps.logger
		this.llmProvider = deps.llmProvider
		this.llmProviders = deps.llmProviders ?? new Map()
		this.toolExecutor = deps.toolExecutor
		this.plugins = deps.plugins
		this.environment = deps.environment
		this.fileStore = deps.fileStore
		this.pluginContexts = deps.pluginContexts ?? new Map()
		this.sendNotification = deps.sendNotification
		this.pluginMethodCaller = deps.pluginMethodCaller
		this.scheduleCallback = deps.schedule
		this.tools = this.buildToolsMap()

		// Initialize turn number from conversation history
		const state = this.state
		if (state) {
			this.turnNumber = state.conversationHistory.filter((m) => m.role === 'assistant').length
		}
	}

	/**
	 * Get the current agent state from store.
	 */
	get state(): AgentState | null {
		return this.store.getAgentState(this.id)
	}

	// ============================================================================
	// Public API
	// ============================================================================

	/**
	 * Unified processing entry point - decides what to do next.
	 * Safe to call multiple times; skips if already processing.
	 */
	async continue(): Promise<void> {
		if (this.processing) return
		if (this.store.isClosed()) return
		this.processing = true
		this.scheduled = false

		try {
			while (true) {
				const agentState = this.state
				if (!agentState) break

				// Rebuild tools map each cycle so plugin-dynamic tools reflect current state
				this.tools = this.buildToolsMap()

				const decision = this.decide(agentState)

				switch (decision) {
					case 'idle':
						this.logger.debug('Agent has nothing to do', {
							agentId: this.id,
							status: agentState.status,
						})
						return

					case 'paused':
						this.logger.debug('Agent is paused, skipping processing', { agentId: this.id })
						return

					case 'on_start':
						await this.executeOnStart(agentState)
						continue

					case 'tool_exec':
						this.logger.info('Executing pending tool calls', {
							agentId: this.id,
							count: agentState.pendingToolCalls.length,
						})
						for (const toolCall of agentState.pendingToolCalls) {
							await this.executeToolCall(toolCall)
						}
						// Schedule re-entry via debounce after tool execution
						// (allows debounce callback to wait for child responses, etc.)
						this.scheduleProcessing()
						return

					case 'resume_from_error':
						await this.store.emit(withSessionId(
							this.store.sessionId,
							agentEvents.create('agent_resumed', { agentId: this.id }),
						))
						continue

					case 'infer':
						await this.runInference(agentState)
						continue

					case 'complete':
						await this.executeOnComplete(agentState)
						return
				}
			}
		} catch (err) {
			if (this.abortController.signal.aborted) {
				this.logger.debug('Agent processing aborted', { agentId: this.id })
				return
			}
			this.logger.error('Unexpected error in agent processing', err instanceof Error ? err : new Error(String(err)), {
				agentId: this.id,
				sessionId: this.store.sessionId,
			})
		} finally {
			this.processing = false
			if (this.pendingReschedule) {
				this.pendingReschedule = false
				this.scheduleProcessing()
			}
		}
	}

	/**
	 * Schedule processing with debounce.
	 * Use this when receiving new messages or after tool execution.
	 */
	scheduleProcessing(): void {
		if (this.scheduled) return
		if (this.store.isClosed()) return
		if (this.processing) {
			this.pendingReschedule = true
			return
		}

		this.cancelSchedule()
		this.scheduled = true

		const agentState = this.state
		if (!agentState) return

		if (this.config.debounceCallback) {
			// Callback-based debounce using recursive setTimeout
			const checkInterval = this.config.checkIntervalMs ?? 100

			const scheduleCheck = () => {
				this.debounceTimer = setTimeout(async () => {
					// Re-read state fresh each check — no stale data
					const currentState = this.state
					if (!currentState) {
						this.cancelSchedule()
						return
					}

					// Guard: schedule could be cancelled between timer fire and here
					if (!this.scheduled) return

					const sessionState = this.store.getState()
					const unconsumed = getUnconsumedMessages(sessionState, this.id)
					const pendingToolResults = currentState.pendingToolResults

					// If no messages, no pending tool results, and no plugin pending, nothing to do
					if (unconsumed.length === 0 && pendingToolResults.length === 0 && !this.hasPluginPendingMessages()) {
						this.cancelSchedule()
						return
					}

					const oldestTimestamp = unconsumed.length > 0
						? Math.min(...unconsumed.map((m) => m.timestamp))
						: Date.now()
					const oldestWaitingMs = Date.now() - oldestTimestamp

					const decision = await this.config.debounceCallback!({
						messages: unconsumed,
						oldestWaitingMs,
						totalPending: unconsumed.length,
						pendingToolResults,
					})

					// Re-check after async callback — schedule could be cancelled during await
					if (!this.scheduled) return

					if (decision === 'process_now') {
						this.cancelSchedule()
						this.continue().catch((err) => {
							this.logger.error('Unhandled error in continue()', err instanceof Error ? err : undefined, { agentId: this.id })
						})
					} else {
						// Callback said "wait" — schedule next check.
						// Fresh state will be read on next iteration.
						scheduleCheck()
					}
				}, checkInterval)
			}

			scheduleCheck()
		} else {
			// Timer-based debounce (default: 500ms)
			const debounceMs = this.config.debounceMs ?? 500
			this.debounceTimer = setTimeout(() => {
				this.scheduled = false
				this.debounceTimer = undefined
				this.continue().catch((err) => {
					this.logger.error('Unhandled error in continue()', err instanceof Error ? err : undefined, { agentId: this.id })
				})
			}, debounceMs)
		}
	}

	/**
	 * Shutdown the agent - cancel any scheduled processing.
	 */
	shutdown(): void {
		try {
			this.abortController.abort()
		} catch {
			// AbortError may be thrown synchronously by abort signal listeners
		}
		this.cancelSchedule()
	}

	/**
	 * Check if processing is scheduled.
	 */
	isScheduled(): boolean {
		return this.scheduled
	}

	// ============================================================================
	// Private methods - Processing
	// ============================================================================

	/**
	 * Determine the next action based on current agent state.
	 */
	private decide(state: AgentState): 'idle' | 'paused' | 'on_start' | 'tool_exec' | 'infer' | 'resume_from_error' | 'complete' {
		if (state.status === 'paused') return 'paused'
		if (!state.onStartCalled) return 'on_start'
		if (state.status === 'tool_exec' && state.pendingToolCalls.length > 0) return 'tool_exec'
		if (state.status === 'pending') {
			if (hasWork(state) || this.hasPluginPendingMessages()) return 'infer'
			return 'complete'
		}
		if (state.status === 'errored') {
			// Errored with new messages (e.g. user sent a message): emit resume event, then retry
			// Only check for new messages, not stale pendingToolResults — those were present when inference failed
			if (this.hasPluginPendingMessages()) return 'resume_from_error'
			return 'complete'
		}
		return 'idle'
	}

	private static readonly MAX_INFERENCE_RETRIES = 3

	/**
	 * Run inference on agent's mailbox.
	 * Runs when there are unconsumed messages OR pending tool results.
	 */
	private async runInference(initialAgentState: AgentState, retryCount = 0): Promise<void> {
		let agentState = initialAgentState
		const hasToolResults = agentState.pendingToolResults.length > 0

		// Collect plugin dequeue messages (includes mailbox messages)
		const pluginDequeued = this.collectPluginMessages()

		// Need either tool results or plugin messages to process
		if (!hasToolResults && pluginDequeued.length === 0) return

		this.turnNumber++

		// 0. beforeInference handler - can skip LLM entirely or pause
		const beforeResult = await this.executeBeforeInference(agentState)
		if (beforeResult !== null) {
			if (beforeResult.action === 'skip') {
				// Skip LLM, use provided response directly
				await this.emitInferenceCompleted(beforeResult.response, undefined)
				return
			}
			if (beforeResult.action === 'pause') {
				return
			}
		}

		// 1. Context compaction is now handled by the context-compact plugin's beforeInference hook
		// (which runs above). If compaction occurred, agent state was updated via context_compacted event.
		// Re-read agent state to pick up any compacted history.
		const postHookState = this.state
		if (postHookState) {
			agentState = postHookState
		}

		// 2. Build pending messages (tool results only)
		const pendingMessages = this.buildPendingMessages(agentState)

		// 2b. Append plugin dequeued messages (includes mailbox messages)
		for (const dequeued of pluginDequeued) {
			pendingMessages.push(...dequeued.messages)
		}

		// 3. Inference start - emit with pending messages
		await this.store.emit(withSessionId(
			this.store.sessionId,
			llmEvents.create('inference_started', {
				agentId: this.id,
				messages: pendingMessages,
				consumedMessageIds: [],
			}),
		))

		// 4. Build LLM messages — re-read state to include inference_started changes
		const preInferenceState = this.state
		if (preInferenceState) {
			agentState = preInferenceState
		}
		const messages = this.buildLLMMessages(agentState, pendingMessages)

		// 4b. Append ephemeral context (not stored in history, recreated each inference)
		const ephemeralParts: string[] = []

		// Collect status messages from all plugins
		const pluginStatus = this.getPluginStatus()
		if (pluginStatus) ephemeralParts.push(pluginStatus)

		if (ephemeralParts.length > 0) {
			messages.push({
				role: 'user',
				content: `<session-context>\n${ephemeralParts.join('\n\n')}\n</session-context>`,
			})
		}

		// Mark cache breakpoint — ephemeral session-context suffix is excluded
		// so it doesn't invalidate the cache on every inference.
		const cachedMessages = applyCacheBreakpoint(messages, ephemeralParts.length > 0 ? 1 : 0)

		// 5. LLM inference (with retry)
		const request: InferenceRequest = {
			model: this.config.model,
			systemPrompt: this.buildSystemPrompt(),
			messages: cachedMessages,
			tools: this.tools.size > 0 ? [...this.tools.values()] : undefined,
			// Stop sequences to prevent hallucination of message tags
			stopSequences: ['<message'],
		}

		this.logger.debug('Running inference', {
			sessionId: this.store.sessionId,
			agentId: this.id,
			messageCount: messages.length,
		})

		// Capture llmCallId from the logging provider
		let llmCallId: LLMCallId | undefined

		const llmResponse = await withLLMRetry(
			() =>
				this.llmProvider.inference(request, {
					sessionId: this.store.sessionId,
					agentId: this.id,
					onLLMCallCreated: (callId) => {
						llmCallId = LLMCallId(callId)
					},
					signal: this.abortController.signal,
					fileStore: this.fileStore,
					providers: this.llmProviders,
				}),
			{ logger: this.logger, signal: this.abortController.signal },
		)

		// Mark plugin messages as consumed (regardless of inference outcome —
		// messages are already appended to conversationHistory via inference_started)
		{
			const currentAgentState = this.state
			if (currentAgentState) {
				const ctx = this.buildAgentContext(currentAgentState)
				for (const dequeued of pluginDequeued) {
					if (!dequeued.plugin.dequeue) continue
					const pluginCtx = this.buildPluginHookContext(dequeued.plugin, ctx)
					await dequeued.plugin.dequeue.markConsumed(pluginCtx, dequeued.token)
				}
			}
		}

		if (!llmResponse.ok) {
			// 4a. Inference failed
			await this.store.emit(withSessionId(
				this.store.sessionId,
				llmEvents.create('inference_failed', {
					agentId: this.id,
					error: llmResponse.error.message,
					llmCallId,
				}),
			))
			// Notify plugins (e.g. mailbox sends error message to parent)
			const errorState = this.state
			if (errorState) {
				await this.executeOnError(errorState, llmResponse.error.message)
			}
			return
		}

		// 4c. Sanitize response to prevent hallucination
		const sanitized = sanitizeLLMResponse(llmResponse.value.content)

		if (sanitized.wasTruncated) {
			this.logger.warn('LLM response was truncated (potential hallucination)', {
				agentId: this.id,
				sessionId: this.store.sessionId,
			})
		}

		// Build response object
		let response: LLMResponse = {
			content: sanitized.content,
			toolCalls: llmResponse.value.toolCalls.map((tc) => ({
				id: tc.id,
				name: tc.name,
				input: tc.input,
			})),
		}

		// 4c. afterInference handler - can modify response, request retry, or pause
		// Re-read state: inference events have been processed since last read
		const postInferenceState = this.state
		if (postInferenceState) {
			agentState = postInferenceState
		}
		const afterResult = await this.executeAfterInference(agentState, response)
		if (afterResult !== null) {
			if (afterResult.action === 'pause') {
				// Inference completed and messages were consumed — commit the turn
				// before pausing so pendingMessages move to conversationHistory.
				await this.emitInferenceCompleted(response, llmCallId, llmResponse.value.metrics)
				await this.emitHandlerPause(afterResult.reason)
				return
			}
			if (afterResult.action === 'retry') {
				if (retryCount >= Agent.MAX_INFERENCE_RETRIES) {
					this.logger.warn('afterInference retry limit reached, continuing with current response', {
						agentId: this.id,
						retryCount,
					})
				} else {
					// Retry inference - decrement turn number and recursively call with fresh state
					this.turnNumber--
					const freshState = this.state
					if (!freshState) return
					await this.runInference(freshState, retryCount + 1)
					return
				}
			} else if (afterResult.action === 'modify') {
				response = afterResult.response
			}
		}

		// 4d. Inference completed
		// Tool calls will be executed in the next continue() cycle
		await this.emitInferenceCompleted(response, llmCallId, llmResponse.value.metrics)
	}

	/**
	 * Emit inference_completed event.
	 */
	private async emitInferenceCompleted(
		response: LLMResponse,
		llmCallId: LLMCallId | undefined,
		metrics?: {
			promptTokens: number
			completionTokens: number
			totalTokens: number
			latencyMs: number
			model: string
			provider?: string
			cost?: number
			cachedTokens?: number
			cacheWriteTokens?: number
		},
	): Promise<void> {
		await this.store.emit(withSessionId(
			this.store.sessionId,
			llmEvents.create('inference_completed', {
				agentId: this.id,
				consumedMessageIds: [],
				response: {
					content: response.content,
					toolCalls: response.toolCalls.map((tc) => ({
						id: ToolCallId(tc.id),
						name: tc.name,
						input: tc.input,
					})),
				},
				metrics: metrics ?? {
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					latencyMs: 0,
					model: 'handler-skip',
				},
				llmCallId,
			}),
		))
	}

	// ============================================================================
	// Private methods - Scheduling
	// ============================================================================

	/**
	 * Cancel any scheduled processing.
	 */
	private cancelSchedule(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = undefined
		}
		this.scheduled = false
		this.pendingReschedule = false
	}

	/**
	 * Execute a single tool call.
	 */
	private async executeToolCall(toolCall: ToolCall): Promise<void> {
		const agentState = this.state
		if (!agentState) return

		// beforeToolCall handler - can block, replace, or pause the tool call
		let effectiveToolCall = toolCall
		const beforeResult = await this.executeBeforeToolCall(agentState, toolCall)
		if (beforeResult !== null) {
			if (beforeResult.action === 'pause') {
				return
			}
			if (beforeResult.action === 'block') {
				// Emit tool_failed with the block reason
				await this.store.emit(withSessionId(
					this.store.sessionId,
					toolEvents.create('tool_started', {
						agentId: this.id,
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						input: toInputRecord(toolCall.input),
					}),
				))
				await this.store.emit(withSessionId(
					this.store.sessionId,
					toolEvents.create('tool_failed', {
						agentId: this.id,
						toolCallId: toolCall.id,
						error: `Tool blocked by handler: ${beforeResult.reason}`,
					}),
				))
				return
			} else if (beforeResult.action === 'replace') {
				effectiveToolCall = {
					id: ToolCallId(beforeResult.toolCall.id),
					name: beforeResult.toolCall.name,
					input: beforeResult.toolCall.input,
				}
			}
		}

		// Start event
		await this.store.emit(withSessionId(
			this.store.sessionId,
			toolEvents.create('tool_started', {
				agentId: this.id,
				toolCallId: effectiveToolCall.id,
				toolName: effectiveToolCall.name,
				input: toInputRecord(effectiveToolCall.input),
			}),
		))

		const tool = this.tools.get(effectiveToolCall.name)
		if (!tool) {
			await this.store.emit(withSessionId(
				this.store.sessionId,
				toolEvents.create('tool_failed', {
					agentId: this.id,
					toolCallId: effectiveToolCall.id,
					error: `Unknown tool: ${effectiveToolCall.name}`,
				}),
			))
			return
		}

		const context: ToolContext = {
			...this.buildAgentContext(agentState),
			logger: this.logger.child({ toolName: toolCall.name }),
		}

		const result = await this.toolExecutor.execute(tool, effectiveToolCall.input, context)

		// Build initial tool result with ToolResultContent
		let toolResult: { isError: boolean; content: ToolResultContent } = result.ok
			? { isError: false, content: result.value }
			: { isError: true, content: result.error.message }

		// afterToolCall handler - can modify result or pause
		const currentAgentState = this.state
		if (currentAgentState) {
			const afterResult = await this.executeAfterToolCall(currentAgentState, effectiveToolCall, toolResult)
			if (afterResult !== null) {
				if (afterResult.action === 'pause') {
					return
				}
				if (afterResult.action === 'modify') {
					toolResult = afterResult.result
				}
			}
		}

		// Result event
		if (!toolResult.isError) {
			await this.store.emit(withSessionId(
				this.store.sessionId,
				toolEvents.create('tool_completed', {
					agentId: this.id,
					toolCallId: effectiveToolCall.id,
					result: toolResult.content,
				}),
			))
		} else {
			// Convert content to string for tool_failed error field
			const errorMessage = typeof toolResult.content === 'string'
				? toolResult.content
				: JSON.stringify(toolResult.content)
			await this.store.emit(withSessionId(
				this.store.sessionId,
				toolEvents.create('tool_failed', {
					agentId: this.id,
					toolCallId: effectiveToolCall.id,
					error: errorMessage,
				}),
			))
		}
	}

	// ============================================================================
	// Handler execution methods
	// ============================================================================

	/**
	 * Emit agent_paused event with reason 'handler'.
	 */
	private async emitHandlerPause(message?: string): Promise<void> {
		await this.store.emit(withSessionId(
			this.store.sessionId,
			agentEvents.create('agent_paused', {
				agentId: this.id,
				reason: 'handler',
				message,
			}),
		))
	}

	/**
	 * Build base AgentContext for handler/hook calls.
	 */
	private buildAgentContext(agentState: AgentState): AgentContext {
		return {
			// SessionContext fields (refreshed from store for up-to-date state)
			sessionId: this.sessionContext.sessionId,
			sessionState: this.store.getState(),
			sessionInput: this.sessionContext.sessionInput,
			environment: this.sessionContext.environment,
			llm: this.sessionContext.llm,
			files: this.sessionContext.files,
			eventStore: this.sessionContext.eventStore,
			llmLogger: this.sessionContext.llmLogger,
			platform: this.sessionContext.platform,
			logger: this.logger,
			emitEvent: this.sessionContext.emitEvent,
			notify: this.sessionContext.notify,
			// AgentContext fields
			agentId: this.id,
			agentState,
			agentConfig: this.config,
			input: agentState.typedInput,
			parentId: agentState.parentId,
		}
	}

	/**
	 * Build PluginHookContext for a specific plugin.
	 * Adds pluginConfig, pluginAgentConfig, pluginContext, pluginState, self.
	 */
	private buildPluginHookContext(plugin: ConfiguredPlugin, agentContext: AgentContext): BasePluginHookContext {
		const pluginState = plugin.slice
			? plugin.slice.select(this.store.getState())
			: undefined

		const self: Record<string, (input: unknown) => Promise<unknown>> = {}
		for (const [methodName] of Object.entries(plugin.methods)) {
			self[methodName] = async (input: unknown) => {
				if (!this.pluginMethodCaller) {
					throw new Error('pluginMethodCaller not available')
				}
				return this.pluginMethodCaller(plugin.name, methodName, input)
			}
		}

		const sendNotification = this.sendNotification
		const pluginName = plugin.name

		const deps = this.pluginMethodCaller
			? buildPluginDeps(plugin.dependencyNames, this.plugins, this.pluginMethodCaller)
			: {}

		const schedule = this.scheduleCallback ?? (() => {})

		return {
			...agentContext,
			pluginConfig: undefined, // injected by plugin builder wrapper
			pluginAgentConfig: this.config.plugins?.find(c => c.pluginName === plugin.name)?.config,
			pluginContext: this.pluginContexts.get(plugin.name),
			pluginState,
			self,
			schedule,
			notify: (type: string, payload: unknown) => {
				sendNotification?.({ pluginName, type, payload })
			},
			deps,
		}
	}

	/**
	 * Emit handler_completed event.
	 *
	 * Skipped when the handler produced no action (null result) — those events are
	 * pure noise (64%+ of a typical session log). onStart is the one exception: the
	 * reducer uses its completion event to flip `onStartCalled`, so we always emit
	 * it even with a null result.
	 */
	private async emitHandlerCompleted(handlerName: HandlerName, result: HandlerResult): Promise<void> {
		if (result === null && handlerName !== 'onStart') return

		await this.store.emit(withSessionId(
			this.store.sessionId,
			agentEvents.create('handler_completed', {
				agentId: this.id,
				handlerName,
				result,
			}),
		))
	}

	/**
	 * Execute onStart handler - called once on first inference.
	 */
	private async executeOnStart(agentState: AgentState): Promise<OnStartResult> {
		this.logger.debug('Executing onStart handlers', { agentId: this.id })

		const agentContext = this.buildAgentContext(agentState)

		// Run all plugin handlers with per-plugin isolation
		// Note: Handlers emit preamble_added events directly via ctx.emitEvent()
		let pauseResult: OnStartResult = null

		for (const plugin of this.plugins) {
			if (!plugin.agentHooks?.onStart) continue
			try {
				const ctx = this.buildPluginHookContext(plugin, agentContext)
				const result = await plugin.agentHooks.onStart(ctx)

				if (result !== null && result.action === 'pause') {
					// Record first pause, but continue running other handlers
					if (pauseResult === null) {
						pauseResult = result
					}
				}
			} catch (error) {
				this.logger.error(`Plugin '${plugin.name}' onStart hook failed`, error instanceof Error ? error : undefined, {
					agentId: this.id,
					plugin: plugin.name,
				})
			}
		}

		await this.emitHandlerCompleted('onStart', pauseResult)

		if (pauseResult !== null) {
			await this.emitHandlerPause(pauseResult.reason)
		}

		return pauseResult
	}

	/**
	 * Execute beforeInference handler.
	 */
	private async executeBeforeInference(
		agentState: AgentState,
	): Promise<BeforeInferenceResult> {
		this.logger.debug('Executing beforeInference handlers', {
			agentId: this.id,
			turnNumber: this.turnNumber,
		})

		const agentContext = this.buildAgentContext(agentState)

		// Run plugin handlers with per-plugin isolation - first skip/pause wins
		for (const plugin of this.plugins) {
			if (!plugin.agentHooks?.beforeInference) continue
			try {
				const ctx = {
					...this.buildPluginHookContext(plugin, agentContext),
					pendingMessages: getUnconsumedMessages(this.store.getState(), this.id),
					turnNumber: this.turnNumber,
				}
				const result = await plugin.agentHooks.beforeInference(ctx)
				if (result === null) {
					continue
				}
				switch (result.action) {
					case 'skip':
						await this.emitHandlerCompleted('beforeInference', result)
						return result
					case 'pause':
						await this.emitHandlerCompleted('beforeInference', result)
						await this.emitHandlerPause(result.reason)
						return result
					default:
						throw new Error(`Unhandled beforeInference action: ${(result as { action: string }).action}`)
				}
			} catch (error) {
				this.logger.error(`Plugin '${plugin.name}' beforeInference hook failed`, error instanceof Error ? error : undefined, {
					agentId: this.id,
					plugin: plugin.name,
				})
			}
		}

		await this.emitHandlerCompleted('beforeInference', null)
		return null
	}

	/**
	 * Execute afterInference handler.
	 */
	private async executeAfterInference(
		agentState: AgentState,
		response: LLMResponse,
	): Promise<AfterInferenceResult> {
		this.logger.debug('Executing afterInference handlers', {
			agentId: this.id,
			turnNumber: this.turnNumber,
		})

		const agentContext = this.buildAgentContext(agentState)

		// Run plugin handlers with per-plugin isolation - first retry/modify/pause wins
		for (const plugin of this.plugins) {
			if (!plugin.agentHooks?.afterInference) continue
			try {
				const ctx = {
					...this.buildPluginHookContext(plugin, agentContext),
					response,
					turnNumber: this.turnNumber,
				}
				const result = await plugin.agentHooks.afterInference(ctx)
				if (result === null) {
					continue
				}
				switch (result.action) {
					case 'retry':
						await this.emitHandlerCompleted('afterInference', result)
						return result
					case 'modify':
						await this.emitHandlerCompleted('afterInference', result)
						return result
					case 'pause':
						await this.emitHandlerCompleted('afterInference', result)
						// Don't emit agent_paused here — caller commits inference first,
						// then pauses (so conversationHistory includes the completed turn).
						return result
					default:
						throw new Error(`Unhandled afterInference action: ${(result as { action: string }).action}`)
				}
			} catch (error) {
				this.logger.error(`Plugin '${plugin.name}' afterInference hook failed`, error instanceof Error ? error : undefined, {
					agentId: this.id,
					plugin: plugin.name,
				})
			}
		}

		await this.emitHandlerCompleted('afterInference', null)
		return null
	}

	/**
	 * Execute beforeToolCall handler.
	 */
	private async executeBeforeToolCall(
		agentState: AgentState,
		toolCall: ToolCall,
	): Promise<BeforeToolCallResult | { action: 'replace'; toolCall: ToolCall }> {
		this.logger.debug('Executing beforeToolCall handlers', {
			agentId: this.id,
			toolName: toolCall.name,
		})

		const agentContext = this.buildAgentContext(agentState)

		// Run plugin handlers with per-plugin isolation - first block/replace/pause wins
		for (const plugin of this.plugins) {
			if (!plugin.agentHooks?.beforeToolCall) continue
			try {
				const ctx = {
					...this.buildPluginHookContext(plugin, agentContext),
					toolCall: {
						id: toolCall.id,
						name: toolCall.name,
						input: toolCall.input,
					},
				}
				const result = await plugin.agentHooks.beforeToolCall(ctx)
				if (result === null) {
					continue
				}
				switch (result.action) {
					case 'block':
						await this.emitHandlerCompleted('beforeToolCall', result)
						return result
					case 'replace':
						await this.emitHandlerCompleted('beforeToolCall', result)
						return {
							action: 'replace',
							toolCall: {
								id: result.toolCall.id,
								name: result.toolCall.name,
								input: result.toolCall.input,
							},
						}
					case 'pause':
						await this.emitHandlerCompleted('beforeToolCall', result)
						await this.emitHandlerPause(result.reason)
						return result
					default:
						throw new Error(`Unhandled beforeToolCall action: ${(result as { action: string }).action}`)
				}
			} catch (error) {
				this.logger.error(`Plugin '${plugin.name}' beforeToolCall hook failed`, error instanceof Error ? error : undefined, {
					agentId: this.id,
					plugin: plugin.name,
					toolName: toolCall.name,
				})
			}
		}

		await this.emitHandlerCompleted('beforeToolCall', null)
		return null
	}

	/**
	 * Execute afterToolCall handler.
	 */
	private async executeAfterToolCall(
		agentState: AgentState,
		toolCall: ToolCall,
		toolResult: { isError: boolean; content: ToolResultContent },
	): Promise<AfterToolCallResult> {
		this.logger.debug('Executing afterToolCall handlers', {
			agentId: this.id,
			toolName: toolCall.name,
		})

		const agentContext = this.buildAgentContext(agentState)

		// Run plugin handlers with per-plugin isolation - first modify/pause wins
		for (const plugin of this.plugins) {
			if (!plugin.agentHooks?.afterToolCall) continue
			try {
				const ctx = {
					...this.buildPluginHookContext(plugin, agentContext),
					toolCall: {
						id: toolCall.id,
						name: toolCall.name,
						input: toolCall.input,
					},
					result: toolResult,
				}
				const result = await plugin.agentHooks.afterToolCall(ctx)
				if (result === null) {
					continue
				}
				switch (result.action) {
					case 'modify':
						await this.emitHandlerCompleted('afterToolCall', result)
						return result
					case 'pause':
						await this.emitHandlerCompleted('afterToolCall', result)
						await this.emitHandlerPause(result.reason)
						return result
					default:
						throw new Error(`Unhandled afterToolCall action: ${(result as { action: string }).action}`)
				}
			} catch (error) {
				this.logger.error(`Plugin '${plugin.name}' afterToolCall hook failed`, error instanceof Error ? error : undefined, {
					agentId: this.id,
					plugin: plugin.name,
					toolName: toolCall.name,
				})
			}
		}

		await this.emitHandlerCompleted('afterToolCall', null)
		return null
	}

	/**
	 * Execute onComplete handler.
	 */
	private async executeOnComplete(agentState: AgentState): Promise<void> {
		this.logger.debug('Executing onComplete handlers', { agentId: this.id })

		const agentContext = this.buildAgentContext(agentState)

		// Run all plugin handlers with per-plugin isolation - first pause wins
		for (const plugin of this.plugins) {
			if (!plugin.agentHooks?.onComplete) continue
			try {
				const ctx = this.buildPluginHookContext(plugin, agentContext)
				const pluginResult = await plugin.agentHooks.onComplete(ctx)
				if (pluginResult === null) {
					continue
				}
				switch (pluginResult.action) {
					case 'pause':
						await this.emitHandlerCompleted('onComplete', pluginResult)
						await this.emitHandlerPause(pluginResult.reason)
						return
					default:
						throw new Error(`Unhandled onComplete action: ${(pluginResult as { action: string }).action}`)
				}
			} catch (error) {
				this.logger.error(`Plugin '${plugin.name}' onComplete hook failed`, error instanceof Error ? error : undefined, {
					agentId: this.id,
					plugin: plugin.name,
				})
			}
		}

		await this.emitHandlerCompleted('onComplete', null)
	}

	/**
	 * Execute onError handler.
	 */
	private async executeOnError(agentState: AgentState, error: string): Promise<void> {
		this.logger.debug('Executing onError handlers', { agentId: this.id })

		const agentContext = this.buildAgentContext(agentState)

		// Run all plugin handlers with per-plugin isolation - first pause wins
		for (const plugin of this.plugins) {
			if (!plugin.agentHooks?.onError) continue
			try {
				const ctx = this.buildPluginHookContext(plugin, agentContext)
				const pluginResult = await plugin.agentHooks.onError({ ...ctx, error })
				if (pluginResult === null) {
					continue
				}
				switch (pluginResult.action) {
					case 'pause':
						await this.emitHandlerCompleted('onError', pluginResult)
						await this.emitHandlerPause(pluginResult.reason)
						return
					default:
						throw new Error(`Unhandled onError action: ${(pluginResult as { action: string }).action}`)
				}
			} catch (error) {
				this.logger.error(`Plugin '${plugin.name}' onError hook failed`, error instanceof Error ? error : undefined, {
					agentId: this.id,
					plugin: plugin.name,
				})
			}
		}

		await this.emitHandlerCompleted('onError', null)
	}

	// ============================================================================
	// Message building
	// ============================================================================

	/**
	 * Build pending messages from tool results.
	 * Mailbox messages are handled by the mailbox plugin's dequeue mechanism.
	 */
	private buildPendingMessages(agentState: AgentState): LLMMessage[] {
		const pending: LLMMessage[] = []

		for (const ptr of agentState.pendingToolResults) {
			pending.push({
				role: 'tool',
				toolCallId: ptr.toolCallId,
				toolName: ptr.toolName,
				content: ptr.content,
				isError: ptr.isError,
				timestamp: ptr.timestamp,
			})
		}

		return pending
	}

	/**
	 * Build LLM messages from agent state and pending messages.
	 * Order: [preamble, conversation history, pending messages]
	 * - Preamble is never compacted (includes skills injected by plugin)
	 * - Conversation history may be compacted
	 * - Pending messages are ephemeral (for current turn)
	 */
	private buildLLMMessages(
		agentState: AgentState,
		pendingMessages: LLMMessage[],
	): LLMMessage[] {
		const messages: LLMMessage[] = []

		// 1. Preamble (ALWAYS prepended, NEVER compacted — includes skills from plugin)
		messages.push(...agentState.preamble)

		// 2. Conversation history (may be compacted)
		messages.push(...agentState.conversationHistory)

		// 3. Pending messages
		messages.push(...pendingMessages)

		return messages
	}

	// ============================================================================
	// Plugin system helpers
	// ============================================================================

	/**
	 * Build merged tools map from config (preset-level) and plugin tools.
	 * Plugin tools override config tools with the same name.
	 */
	private buildToolsMap(): Map<string, ToolDefinition> {
		const tools = new Map<string, ToolDefinition>()
		/** Track which source registered each tool name for collision detection */
		const toolSources = new Map<string, string>()

		// 1. Static tools from config (preset-level)
		for (const tool of this.config.tools ?? []) {
			tools.set(tool.name, tool)
			toolSources.set(tool.name, 'config')
		}

		// 2. Plugin tools (override static)
		const agentState = this.state
		if (agentState) {
			const agentContext = this.buildAgentContext(agentState)
			for (const plugin of this.plugins) {
				if (!plugin.getTools) continue
				const ctx = this.buildPluginHookContext(plugin, agentContext)
				for (const tool of plugin.getTools(ctx)) {
					const existing = toolSources.get(tool.name)
					if (existing) {
						this.logger.warn(`Tool name collision: '${tool.name}' from plugin '${plugin.name}' overrides '${existing}'`, {
							agentId: this.id,
							toolName: tool.name,
						})
					}
					tools.set(tool.name, tool)
					toolSources.set(tool.name, `plugin:${plugin.name}`)
				}
			}
		}

		return tools
	}

	/**
	 * Build composed system prompt from base briefing, plugin sections, environment, and preset prompt.
	 */
	private buildSystemPrompt(): string {
		const sections: string[] = []

		// 1. Framework base briefing (always first)
		sections.push(AGENT_BASE_BRIEFING)

		// 2. Plugin system prompt sections
		const agentState = this.state
		if (agentState) {
			const agentContext = this.buildAgentContext(agentState)
			for (const plugin of this.plugins) {
				if (!plugin.getSystemPrompt) continue
				const ctx = this.buildPluginHookContext(plugin, agentContext)
				const section = plugin.getSystemPrompt(ctx)
				if (section) sections.push(section)
			}
		}

		// 3. Environment section
		const roots = this.fileStore.getRoots()
		sections.push(buildEnvironmentSection({
			sessionPath: roots.session,
			workspacePath: roots.workspace,
		}))

		// 4. Custom prompt from preset (last)
		if (this.config.systemPrompt) {
			let customPrompt = this.config.systemPrompt
			customPrompt = customPrompt.replaceAll('{{sessionDir}}', roots.session)
			if (roots.workspace) {
				customPrompt = customPrompt.replaceAll('{{workspaceDir}}', roots.workspace)
			}
			sections.push(customPrompt)
		}

		return sections.filter(Boolean).join('\n\n').trim()
	}

	/**
	 * Get combined status from all plugins.
	 */
	private getPluginStatus(): string | null {
		const agentState = this.state
		if (!agentState) return null

		const agentContext = this.buildAgentContext(agentState)
		const parts: string[] = []

		for (const plugin of this.plugins) {
			if (!plugin.getStatus) continue
			const ctx = this.buildPluginHookContext(plugin, agentContext)
			const status = plugin.getStatus(ctx)
			if (status) parts.push(status)
		}

		return parts.length > 0 ? parts.join('\n\n') : null
	}

	// ============================================================================
	// Plugin dequeue helpers
	// ============================================================================

	/**
	 * Check if any plugin has pending messages for this agent.
	 */
	private hasPluginPendingMessages(): boolean {
		const agentState = this.state
		if (!agentState) return false

		const agentContext = this.buildAgentContext(agentState)
		for (const plugin of this.plugins) {
			if (!plugin.dequeue) continue
			const ctx = this.buildPluginHookContext(plugin, agentContext)
			if (plugin.dequeue.hasPendingMessages(ctx)) return true
		}
		return false
	}

	/**
	 * Collect pending messages from all plugins that have dequeue hooks.
	 * Returns array of { plugin, messages, token } for each plugin with pending messages.
	 */
	private collectPluginMessages(): Array<{
		plugin: ConfiguredPlugin
		messages: LLMMessage[]
		token: unknown
	}> {
		const agentState = this.state
		if (!agentState) return []

		const agentContext = this.buildAgentContext(agentState)
		const collected: Array<{
			plugin: ConfiguredPlugin
			messages: LLMMessage[]
			token: unknown
		}> = []

		for (const plugin of this.plugins) {
			if (!plugin.dequeue) continue
			const ctx = this.buildPluginHookContext(plugin, agentContext)
			const result = plugin.dequeue.getPendingMessages(ctx)
			if (result) {
				collected.push({
					plugin,
					messages: result.messages,
					token: result.token,
				})
			}
		}

		return collected
	}
}

// ============================================================================
// Local helpers (inlined from @roj-ai/core)
// ============================================================================

function getUnconsumedMessages(sessionState: SessionState, agentId: AgentId) {
	return getAgentUnconsumedMailbox(selectMailboxState(sessionState), agentId)
}

function hasWork(agent: AgentState): boolean {
	// Has pending tool results - needs LLM to process
	if (agent.pendingToolResults.length > 0) return true

	return false
}

/**
 * Narrow tool call input from `unknown` to `Record<string, unknown>`.
 * Tool inputs are always validated objects from Zod schemas.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toInputRecord(input: unknown): Record<string, unknown> {
	if (isRecord(input)) {
		return input
	}
	return {}
}
