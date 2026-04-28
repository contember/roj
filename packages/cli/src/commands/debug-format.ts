import type { LLMCallLogEntry } from '@roj-ai/sdk'
import type { DomainEvent } from '@roj-ai/sdk'
import type {
	AgentTreeNode,
	ConversationMessageView,
	GetAgentDetailResponse,
	GetMetricsResponse,
	GlobalMailboxMessage,
	TimelineItem,
} from '@roj-ai/shared'

// ANSI color codes
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const MAGENTA = '\x1b[35m'

export function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str
	return str.slice(0, maxLen - 1) + '\u2026'
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return '-'
	if (ms < 1000) return `${ms}ms`
	return `${(ms / 1000).toFixed(1)}s`
}

function formatTimestamp(ts: number): string {
	return new Date(ts).toLocaleTimeString()
}

function statusColor(status: string): string {
	switch (status) {
		case 'idle':
		case 'success':
			return GREEN
		case 'thinking':
		case 'responding':
		case 'running':
			return YELLOW
		case 'error':
			return RED
		default:
			return ''
	}
}

// ============================================================================
// Agent Tree
// ============================================================================

export function formatAgentTree(nodes: AgentTreeNode[]): string {
	const lines: string[] = []
	for (let i = 0; i < nodes.length; i++) {
		const isLast = i === nodes.length - 1
		formatTreeNode(lines, nodes[i], '', isLast)
	}
	return lines.join('\n')
}

function formatCost(cost: number): string {
	if (cost >= 1) return `$${cost.toFixed(2)}`
	return `$${cost.toFixed(4)}`
}

function formatTreeNode(lines: string[], node: AgentTreeNode, prefix: string, isLast: boolean): void {
	const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251c\u2500\u2500 '
	const childPrefix = prefix + (isLast ? '    ' : '\u2502   ')
	const color = statusColor(node.status)

	// Line 1: name + status
	lines.push(`${prefix}${connector}${BOLD}${node.definitionName}${RESET} ${color}[${node.status}]${RESET}`)

	// Line 2: cost + badges + id
	const details: string[] = []
	if (node.cost > 0) details.push(`${GREEN}${formatCost(node.cost)}${RESET}`)
	if (node.isExecuting) details.push(`${YELLOW}executing${RESET}`)
	if (node.mailboxCount > 0) details.push(`${CYAN}${node.mailboxCount} msgs${RESET}`)
	if (node.pendingToolCalls > 0) details.push(`${MAGENTA}${node.pendingToolCalls} tools${RESET}`)
	const detailStr = details.length > 0 ? details.join(` ${DIM}\u00b7${RESET} `) + '  ' : ''
	lines.push(`${childPrefix}${detailStr}${DIM}${node.id}${RESET}`)

	// Children
	for (let i = 0; i < node.children.length; i++) {
		const childIsLast = i === node.children.length - 1
		formatTreeNode(lines, node.children[i], childPrefix, childIsLast)
	}
}

// ============================================================================
// Agent Detail
// ============================================================================

export function formatAgentDetail(detail: GetAgentDetailResponse): string {
	const lines: string[] = []
	const color = statusColor(detail.status)

	// Header
	lines.push(`${BOLD}Agent: ${detail.definitionName}${RESET}`)
	lines.push(`  ID:     ${detail.id}`)
	lines.push(`  Status: ${color}${detail.status}${RESET}`)
	lines.push(`  Parent: ${detail.parentId ?? 'none'}`)

	// Mailbox
	lines.push('')
	lines.push(`${BOLD}Mailbox${RESET} (${detail.mailbox.length} messages)`)
	if (detail.mailbox.length === 0) {
		lines.push(`  ${DIM}(empty)${RESET}`)
	} else {
		for (const msg of detail.mailbox) {
			const consumed = msg.consumed ? `${DIM}[consumed]${RESET}` : `${YELLOW}[pending]${RESET}`
			lines.push(`  ${msg.from} ${consumed}: ${truncate(msg.content, 80)}`)
		}
	}

	// Conversation
	lines.push('')
	lines.push(`${BOLD}Conversation${RESET} (${detail.conversationHistory.length} messages)`)
	if (detail.conversationHistory.length === 0) {
		lines.push(`  ${DIM}(empty)${RESET}`)
	} else {
		for (const msg of detail.conversationHistory) {
			lines.push(formatConversationMessage(msg))
		}
	}

	// Pending Tool Calls
	if (detail.pendingToolCalls.length > 0) {
		lines.push('')
		lines.push(`${BOLD}Pending Tool Calls${RESET} (${detail.pendingToolCalls.length})`)
		for (const tc of detail.pendingToolCalls) {
			lines.push(`  ${MAGENTA}${tc.name}${RESET} [${tc.status}] ${DIM}${tc.id}${RESET}`)
			if (tc.input) {
				lines.push(`    Input: ${truncate(JSON.stringify(tc.input), 100)}`)
			}
		}
	}

	return lines.join('\n')
}

function formatConversationMessage(msg: ConversationMessageView): string {
	switch (msg.role) {
		case 'user':
			return `  ${GREEN}user:${RESET} ${truncate(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content), 100)}`
		case 'assistant': {
			const content = msg.content ? truncate(msg.content, 100) : ''
			const toolsInfo = msg.toolCalls?.length ? ` ${DIM}[${msg.toolCalls.length} tool calls]${RESET}` : ''
			return `  ${CYAN}assistant:${RESET} ${content}${toolsInfo}`
		}
		case 'tool': {
			const errTag = msg.isError ? `${RED}[error]${RESET} ` : ''
			return `  ${MAGENTA}tool(${msg.toolCallId}):${RESET} ${errTag}${truncate(msg.content, 100)}`
		}
		case 'system':
			return `  ${DIM}system: ${truncate(msg.content, 100)}${RESET}`
	}
}

// ============================================================================
// Timeline
// ============================================================================

export function formatTimelineItem(item: TimelineItem): string {
	const status = `${statusColor(item.status)}${item.status}${RESET}`
	const duration = formatDuration(item.durationMs)
	const time = formatTimestamp(item.startedAt)

	switch (item.type) {
		case 'llm': {
			const model = item.model ?? '-'
			const tokens = item.promptTokens !== undefined ? `${item.promptTokens}/${item.completionTokens}` : '-'
			return `${time}  ${CYAN}llm${RESET}      ${item.agentName.padEnd(20)}  ${status.padEnd(20)}  ${duration.padStart(8)}  ${model}  ${tokens}`
		}
		case 'tool': {
			const toolName = item.toolName ?? '-'
			return `${time}  ${MAGENTA}tool${RESET}     ${item.agentName.padEnd(20)}  ${status.padEnd(20)}  ${duration.padStart(8)}  ${toolName}`
		}
		case 'compaction': {
			const info = item.originalTokens !== undefined
				? `${item.originalTokens} -> ${item.compactedTokens} tokens, ${item.messagesRemoved} msgs removed`
				: ''
			return `${time}  ${YELLOW}compact${RESET}  ${item.agentName.padEnd(20)}  ${status.padEnd(20)}  ${DIM}${info}${RESET}`
		}
	}
}

// ============================================================================
// Mailbox
// ============================================================================

export function formatMailboxMessage(msg: GlobalMailboxMessage): string {
	const status = msg.consumed ? `${DIM}[consumed]${RESET}` : `${YELLOW}[pending]${RESET}`
	const time = formatTimestamp(msg.timestamp)
	return `${time}  ${msg.fromAgentName} -> ${msg.toAgentName}  ${status}  ${truncate(msg.content, 60)}`
}

// ============================================================================
// Metrics
// ============================================================================

export function formatMetrics(metrics: GetMetricsResponse): string {
	const lines: string[] = []
	lines.push(`${BOLD}Session Metrics${RESET}`)
	lines.push(`  Total tokens:      ${metrics.totalTokens.toLocaleString()}`)
	lines.push(`  Prompt tokens:     ${metrics.promptTokens.toLocaleString()}`)
	lines.push(`  Completion tokens: ${metrics.completionTokens.toLocaleString()}`)
	if (metrics.totalCost !== undefined) {
		lines.push(`  Cost:              $${metrics.totalCost.toFixed(4)}`)
	}
	lines.push(`  LLM calls:         ${metrics.llmCalls}`)
	lines.push(`  Tool calls:        ${metrics.toolCalls}`)
	lines.push(`  Agent count:       ${metrics.agentCount}`)
	lines.push(`  Duration:          ${formatDuration(metrics.durationMs)}`)
	return lines.join('\n')
}

// ============================================================================
// LLM Call Detail
// ============================================================================

export function formatLLMCallDetail(call: LLMCallLogEntry): string {
	const lines: string[] = []

	lines.push(`${BOLD}LLM Call: ${call.id}${RESET}`)
	lines.push(`  Agent:    ${call.agentId}`)
	lines.push(`  Status:   ${statusColor(call.status)}${call.status}${RESET}`)
	lines.push(`  Created:  ${new Date(call.createdAt).toLocaleString()}`)
	if (call.durationMs !== undefined) {
		lines.push(`  Duration: ${formatDuration(call.durationMs)}`)
	}

	// Request
	lines.push('')
	lines.push(`${BOLD}Request${RESET}`)
	lines.push(`  Model:    ${call.request.model}`)
	lines.push(`  Messages: ${call.request.messages.length}`)
	lines.push(`  Tools:    ${call.request.toolsCount}`)
	if (call.request.systemPrompt) {
		lines.push(`  System:   ${truncate(call.request.systemPrompt, 100)}`)
	}

	// Response
	if (call.response) {
		lines.push('')
		lines.push(`${BOLD}Response${RESET}`)
		lines.push(`  Finish:   ${call.response.finishReason}`)
		if (call.response.content) {
			lines.push(`  Content:  ${truncate(call.response.content, 200)}`)
		}
		if (call.response.toolCalls.length > 0) {
			lines.push(`  Tool calls: ${call.response.toolCalls.length}`)
			for (const tc of call.response.toolCalls) {
				lines.push(`    ${MAGENTA}${tc.name}${RESET} ${DIM}${tc.id}${RESET}`)
			}
		}
	}

	// Metrics
	if (call.metrics) {
		lines.push('')
		lines.push(`${BOLD}Metrics${RESET}`)
		lines.push(`  Prompt:     ${call.metrics.promptTokens.toLocaleString()} tokens`)
		lines.push(`  Completion: ${call.metrics.completionTokens.toLocaleString()} tokens`)
		lines.push(`  Total:      ${call.metrics.totalTokens.toLocaleString()} tokens`)
		if (call.metrics.cost !== undefined) {
			lines.push(`  Cost:       $${call.metrics.cost.toFixed(4)}`)
		}
		lines.push(`  Latency:    ${formatDuration(call.metrics.latencyMs)}`)
	}

	// Error
	if (call.error) {
		lines.push('')
		lines.push(`${RED}${BOLD}Error${RESET}`)
		lines.push(`  ${RED}${call.error.type}: ${call.error.message}${RESET}`)
	}

	return lines.join('\n')
}

// ============================================================================
// Event Row
// ============================================================================

export function formatEventRow(event: DomainEvent, index: number): string[] {
	const agentId = 'agentId' in event ? String(event.agentId) : '-'
	return [
		String(index),
		event.type,
		truncate(agentId, 24),
		formatTimestamp(event.timestamp),
	]
}
