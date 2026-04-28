import type { AgentId } from '~/core/agents/schema.js'
import type { CompactedConversationMessage, ContextCompactedEvent } from '~/core/context/state.js'
import { contextEvents } from '~/core/context/state.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { LLMMessage, LLMProvider } from '~/core/llm/provider.js'
import type { ModelId } from '~/core/llm/schema.js'
import { estimateMessagesTokens } from '~/core/llm/tokens.js'
import type { SessionId } from '~/core/sessions/schema.js'
import type { Result } from '~/lib/utils/result.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { Logger } from '../../lib/logger/logger.js'
import { CONTEXT_SUMMARY_PROMPT, wrapContextSummary } from '../../prompts/index.js'

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
	/** Model ID to use for summarization (required) */
	model: ModelId
	/** Token threshold to trigger compaction */
	maxTokens: number
	/** Number of recent messages to keep uncompacted */
	keepRecentMessages: number
	/** Max tokens for kept recent messages (whichever limit is hit first) */
	keepRecentTokens?: number
	/** Target token count after compaction (informational) */
	targetTokens?: number
	/** System prompt for summarization */
	summaryPrompt?: string
	/** Enable history offloading before compaction */
	offloadHistory?: boolean
	/** Path prefix for offloaded history (default: /session/.history/) */
	historyPathPrefix?: string
}

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
		private readonly llmProvider: LLMProvider,
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
	 * Check if compaction is needed based on token count.
	 */
	needsCompaction(messages: LLMMessage[]): boolean {
		const tokens = estimateMessagesTokens(messages)
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
	): Promise<Result<CompactionResult | null, Error>> {
		if (!this.needsCompaction(messages)) {
			return Ok(null)
		}

		return this.compact(sessionId, agentId, messages)
	}

	/**
	 * Compact conversation history by summarizing older messages.
	 */
	async compact(
		sessionId: SessionId,
		agentId: AgentId,
		messages: LLMMessage[],
	): Promise<Result<CompactionResult, Error>> {
		const originalTokens = estimateMessagesTokens(messages)

		this.logger.info('Starting context compaction', {
			sessionId,
			agentId,
			messageCount: messages.length,
			estimatedTokens: originalTokens,
		})

		// Split messages: keep recent, compact older
		// Respect both count limit and token budget (whichever is hit first)
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

		// Format messages for summarization
		const conversationText = toCompact
			.map(formatMessageForSummary)
			.join('\n\n')

		// Offload history if enabled
		let historyPath: string | undefined
		if (this.config.offloadHistory && this.historyOffloader) {
			try {
				const pathPrefix = this.config.historyPathPrefix ?? DEFAULT_HISTORY_PATH_PREFIX
				historyPath = await this.historyOffloader.offload(agentId, conversationText, pathPrefix)
				this.logger.info('History offloaded', { sessionId, agentId, historyPath })
			} catch (error) {
				// History offloading is best-effort, log and continue
				this.logger.warn('Failed to offload history', {
					sessionId,
					agentId,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}

		// Generate summary using LLM
		const summaryResult = await this.llmProvider.inference({
			model: this.config.model,
			systemPrompt: this.config.summaryPrompt ?? CONTEXT_SUMMARY_PROMPT,
			messages: [
				{
					role: 'user',
					content: `Please summarize this conversation:\n\n${conversationText}`,
				},
			],
			tools: [],
		})

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

		// Create summary message (with history reference if offloaded)
		const summaryMessage: LLMMessage = {
			role: 'system',
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
