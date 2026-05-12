import type { AgentId } from '~/core/agents/schema.js'
import type { CompactedConversationMessage, ContextCompactedEvent } from '~/core/context/state.js'
import { contextEvents } from '~/core/context/state.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { InferenceResponse, LLMError, LLMMessage } from '~/core/llm/provider.js'
import type { ModelId } from '~/core/llm/schema.js'
import { estimateMessagesTokens } from '~/core/llm/tokens.js'
import type { SessionId } from '~/core/sessions/schema.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { Logger } from '../../lib/logger/logger.js'
import { wrapContextSummary } from '../../prompts/index.js'

/**
 * Callback used by the compactor to ask the host (an Agent) to run a side-channel
 * inference reusing its own system prompt, tools, and conversation prefix.
 *
 * Implemented in practice by AgentContext.runAuxiliaryInference, which keeps the
 * agent's prompt cache warm — only the trailing `extraMessages` and the response
 * tokens are paid for; the rest of the prefix is served from cache.
 */
export type RunInferenceFn = (extraMessages: LLMMessage[]) => Promise<Result<InferenceResponse, LLMError>>

// ============================================================================
// Message formatting for summarization
// ============================================================================

/** Max length for tool result content in summary (prevents bloat) */
const TOOL_RESULT_MAX_LENGTH = 500
const TOOL_RESULT_TRUNCATE_EDGE = 250

/**
 * Format a single message for summarization.
 * Handles all message types including tool calls and tool results.
 */
export function formatMessageForSummary(msg: LLMMessage): string {
	switch (msg.role) {
		case 'user': {
			const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
			return `User: ${content}`
		}

		case 'assistant': {
			const parts: string[] = []
			if (msg.content) {
				parts.push(msg.content)
			}
			if (msg.toolCalls?.length) {
				const toolCallsDesc = msg.toolCalls
					.map((tc) => `${tc.name}(${formatToolInput(tc.input)})`)
					.join(', ')
				parts.push(`[Called tools: ${toolCallsDesc}]`)
			}
			return `Agent: ${parts.join('\n')}`
		}

		case 'tool': {
			const toolName = msg.toolName ?? 'unknown'
			const content = typeof msg.content === 'string'
				? msg.content
				: JSON.stringify(msg.content)
			// Truncate large tool results for summarization
			const truncated = content.length > TOOL_RESULT_MAX_LENGTH
				? content.slice(0, TOOL_RESULT_TRUNCATE_EDGE) + '\n...(truncated)...\n' + content.slice(-TOOL_RESULT_TRUNCATE_EDGE)
				: content
			return `Tool(${toolName}): ${truncated}`
		}

		case 'system':
			return `System: ${msg.content}`
	}
}

/**
 * Format tool input for summarization (show just key names for brevity).
 */
function formatToolInput(input: unknown): string {
	if (typeof input === 'object' && input !== null) {
		return Object.keys(input).join(', ')
	}
	return String(input).slice(0, 50)
}

// ============================================================================
// Configuration
// ============================================================================

export interface CompactionConfig {
	/**
	 * @deprecated No longer used. Summarization runs on the agent's own model via
	 * the auxiliary inference callback so the agent's prompt cache is reused.
	 * Kept in the interface so existing preset configs continue to type-check.
	 */
	model?: ModelId
	/** Token threshold to trigger compaction. */
	maxTokens: number
	/** Number of recent messages to keep uncompacted. */
	keepRecentMessages: number
	/** Max tokens for kept recent messages (whichever limit is hit first). */
	keepRecentTokens?: number
	/** Target token count after compaction (informational). */
	targetTokens?: number
	/** Optional override for the trailing summarization instruction sent to the model. */
	summaryPrompt?: string
	/** Enable history offloading before compaction. */
	offloadHistory?: boolean
	/** Path prefix for offloaded history (default: /session/.history/). */
	historyPathPrefix?: string
}

/**
 * Trailing user-message instruction appended to the agent's full prefix when
 * requesting a summary. The model sees its real system prompt, tools and full
 * conversation, then this instruction last. Phrased to discourage tool calls
 * — Sonnet-class models reliably emit a plain text response under this prompt.
 */
export const DEFAULT_SUMMARY_INSTRUCTION =
	'[CONTEXT COMPACTION REQUEST]\n'
	+ 'The conversation above is approaching the context budget. Produce a concise '
	+ 'summary (under 600 words) of everything discussed and decided so far. Cover: '
	+ 'completed tasks and their outcomes, key decisions and rationale, current state '
	+ 'of any in-progress work, important file paths or identifiers, and outstanding '
	+ 'questions.\n\n'
	+ 'Reply with plain text only. Do NOT call any tools. Do NOT acknowledge this '
	+ 'request — just emit the summary directly.'

// ============================================================================
// Compaction Result
// ============================================================================

export interface CompactionResult {
	/** New messages to use (summary + kept messages) */
	compactedMessages: LLMMessage[]
	/** Generated summary text */
	summary: string
	/** Token count before compaction */
	originalTokens: number
	/** Token count after compaction */
	compactedTokens: number
	/** Number of messages that were removed/summarized */
	messagesRemoved: number
	/** Path to offloaded full history (if enabled) */
	historyPath?: string
}

// ============================================================================
// History Offloader
// ============================================================================

/** Default path prefix for offloaded history */
export const DEFAULT_HISTORY_PATH_PREFIX = '/session/.history/'

/**
 * Interface for offloading conversation history to files.
 * This is optional - if not provided, history offloading is disabled.
 */
export interface HistoryOffloader {
	/**
	 * Offload conversation history to a file.
	 * @param agentId - ID of the agent whose history is being offloaded
	 * @param content - Formatted conversation content
	 * @param pathPrefix - Path prefix for history files
	 * @returns Path to the offloaded history file
	 */
	offload(agentId: AgentId, content: string, pathPrefix: string): Promise<string>
}

// ============================================================================
// Context Compactor
// ============================================================================

export class ContextCompactor {
	constructor(
		private readonly logger: Logger,
		private readonly config: CompactionConfig,
		private readonly historyOffloader?: HistoryOffloader,
	) {}

	/**
	 * Compute how many recent messages to keep, respecting both count and token limits.
	 * Ensures the kept portion never starts with orphaned tool results (tool messages
	 * without their preceding assistant tool-call message).
	 */
	private computeKeepCount(messages: LLMMessage[]): number {
		const maxCount = Math.min(this.config.keepRecentMessages, messages.length)
		const tokenBudget = this.config.keepRecentTokens

		let count: number
		if (tokenBudget === undefined) {
			count = maxCount
		} else {
			count = 0
			let tokens = 0
			for (let i = messages.length - 1; i >= 0 && count < maxCount; i--) {
				const msgTokens = estimateMessagesTokens([messages[i]])
				if (tokens + msgTokens > tokenBudget) break
				tokens += msgTokens
				count++
			}
		}

		// Move split point forward to avoid orphaned tool results at the start of kept messages
		while (count > 0 && messages[messages.length - count].role === 'tool') {
			count--
		}

		return count
	}

	/**
	 * Check if compaction is needed.
	 *
	 * Prefers the provider-reported prompt token count from the previous turn
	 * (authoritative — comes straight from the model's tokenizer). Falls back
	 * to the in-process estimator when no previous metrics exist (first turn).
	 *
	 * The estimator under-counts JSON-heavy tool-result history by ~2x, so
	 * relying on it alone causes the trigger to never fire in long sessions.
	 */
	needsCompaction(messages: LLMMessage[], lastActualPromptTokens?: number): boolean {
		const tokens = lastActualPromptTokens ?? estimateMessagesTokens(messages)
		return tokens > this.config.maxTokens
	}

	/**
	 * Compact conversation history if needed.
	 * Returns null if compaction was not needed.
	 */
	async compactIfNeeded(
		sessionId: SessionId,
		agentId: AgentId,
		messages: LLMMessage[],
		runInference: RunInferenceFn,
		lastActualPromptTokens?: number,
	): Promise<Result<CompactionResult | null, Error>> {
		if (!this.needsCompaction(messages, lastActualPromptTokens)) {
			return Ok(null)
		}

		return this.compact(sessionId, agentId, messages, runInference, lastActualPromptTokens)
	}

	/**
	 * Compact conversation history by asking the agent's own model to summarize
	 * the older portion. The summarization call reuses the agent's existing
	 * prompt cache via `runInference`, paying only for the trailing instruction
	 * (a few hundred tokens) and the summary output — not the whole conversation
	 * a second time.
	 */
	async compact(
		sessionId: SessionId,
		agentId: AgentId,
		messages: LLMMessage[],
		runInference: RunInferenceFn,
		lastActualPromptTokens?: number,
	): Promise<Result<CompactionResult, Error>> {
		const originalTokens = lastActualPromptTokens ?? estimateMessagesTokens(messages)

		this.logger.info('Starting context compaction', {
			sessionId,
			agentId,
			messageCount: messages.length,
			originalTokens,
			actualTokensReported: lastActualPromptTokens !== undefined,
		})

		// Split messages: keep recent, compact older.
		// Respect both count limit and token budget (whichever is hit first).
		const keepCount = this.computeKeepCount(messages)
		const toCompact = messages.slice(0, messages.length - keepCount)
		const toKeep = messages.slice(messages.length - keepCount)

		if (toCompact.length === 0) {
			this.logger.warn('No messages to compact', { sessionId, agentId })
			return Ok({
				compactedMessages: messages,
				summary: '',
				originalTokens,
				compactedTokens: originalTokens,
				messagesRemoved: 0,
			})
		}

		// Offload the dropped messages to disk for forensics / replay.
		// Best-effort; failures are logged but don't block compaction.
		let historyPath: string | undefined
		if (this.config.offloadHistory && this.historyOffloader) {
			try {
				const conversationText = toCompact.map(formatMessageForSummary).join('\n\n')
				const pathPrefix = this.config.historyPathPrefix ?? DEFAULT_HISTORY_PATH_PREFIX
				historyPath = await this.historyOffloader.offload(agentId, conversationText, pathPrefix)
				this.logger.info('History offloaded', { sessionId, agentId, historyPath })
			} catch (error) {
				this.logger.warn('Failed to offload history', {
					sessionId,
					agentId,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}

		// Inline summarization: append the instruction as a trailing user message
		// and let the host run inference with the agent's full live prefix. The
		// agent's prompt cache from the previous turn covers everything up to
		// (but not including) this instruction.
		const summaryInstruction = this.config.summaryPrompt ?? DEFAULT_SUMMARY_INSTRUCTION
		const summaryResult = await runInference([
			{ role: 'user', content: summaryInstruction },
		])

		if (!summaryResult.ok) {
			const llmError = summaryResult.error
			this.logger.error('Failed to generate summary', new Error(llmError.message), {
				sessionId,
				agentId,
				errorType: llmError.type,
			})
			return Err(new Error(`Compaction failed: ${llmError.message}`))
		}

		const summary = summaryResult.value.content ?? ''

		if (!summary.trim()) {
			this.logger.warn('Summarization returned empty content', { sessionId, agentId })
			return Err(new Error('Compaction failed: model returned empty summary'))
		}

		// Replace the compacted portion with a single user-role summary message.
		// Using `user` role (not `system`) so the wrap reads as part of the
		// conversation flow — Anthropic recommends user-role for arbitrary
		// mid-conversation context blocks.
		const summaryMessage: LLMMessage = {
			role: 'user',
			content: wrapContextSummary(summary, historyPath),
		}

		const compactedMessages = [summaryMessage, ...toKeep]
		const compactedTokens = estimateMessagesTokens(compactedMessages)

		this.logger.info('Context compaction complete', {
			sessionId,
			agentId,
			originalMessages: messages.length,
			compactedMessages: compactedMessages.length,
			originalTokens,
			compactedTokens,
			reduction: `${Math.round((1 - compactedTokens / originalTokens) * 100)}%`,
		})

		return Ok({
			compactedMessages,
			summary,
			originalTokens,
			compactedTokens,
			messagesRemoved: toCompact.length,
			historyPath,
		})
	}
}

// ============================================================================
// Event creation helper
// ============================================================================

export function createContextCompactedEvent(
	sessionId: SessionId,
	agentId: AgentId,
	result: CompactionResult,
): ContextCompactedEvent {
	// Convert LLMMessage[] to CompactedConversationMessage[]
	const newConversationHistory: CompactedConversationMessage[] = result.compactedMessages.map((msg) => ({
		role: msg.role === 'tool' ? 'system' : msg.role,
		content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
	}))

	return withSessionId(
		sessionId,
		contextEvents.create('context_compacted', {
			agentId,
			compactedContent: result.summary,
			newConversationHistory,
			originalTokens: result.originalTokens,
			compactedTokens: result.compactedTokens,
			messagesRemoved: result.messagesRemoved,
			historyPath: result.historyPath,
		}),
	)
}
