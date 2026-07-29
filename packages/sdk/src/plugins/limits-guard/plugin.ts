import { AgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { contextEvents } from '~/core/context/state.js'
import { llmEvents } from '~/core/llm/state.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import type { SessionState } from '~/core/sessions/state.js'
import { toolEvents } from '~/core/tools/state.js'
import { responseFingerprint, toolCallFingerprint } from '~/lib/utils/hash.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import type { AgentLimits, LimitsSessionConfig } from './config.js'
import {
	type BudgetSpend,
	checkBudget,
	checkLimits,
	countConsecutiveTailDuplicates,
	resolveAgentLimits,
	resolveSessionLimits,
} from './limit-guard.js'

// ============================================================================
// Agent counters (state)
// ============================================================================

export interface AgentCounters {
	inferenceCount: number
	toolCallCount: number
	spawnedAgentCount: number
	messagesSentCount: number
	/** Consecutive inference turns whose only tool calls were outbound communication. */
	consecutiveNoProgressTurns: number
	/** Number of context compaction events for this agent. */
	compactionCount: number
	/** Cumulative LLM cost (USD) summed from inference metrics. NOT reset on resume. */
	costSpent: number
	/** Cumulative total tokens (prompt + completion). NOT reset on resume. */
	tokensUsed: number
	/** Tool name → consecutive failure count + last error message. Reset on success. */
	consecutiveToolFailures: Record<string, { count: number; lastError: string }>
	/** Ring buffer of last 20 tool call fingerprints ("toolName:inputHash") */
	recentToolCallHashes: string[]
	/** Ring buffer of last 10 response content hashes (text-only responses without tool calls) */
	recentResponseHashes: string[]
}

export const createAgentCounters = (): AgentCounters => ({
	inferenceCount: 0,
	toolCallCount: 0,
	spawnedAgentCount: 0,
	messagesSentCount: 0,
	consecutiveNoProgressTurns: 0,
	compactionCount: 0,
	costSpent: 0,
	tokensUsed: 0,
	consecutiveToolFailures: {},
	recentToolCallHashes: [],
	recentResponseHashes: [],
})

/** Sum cost + tokens across all agents in the session (for the session-wide budget). */
export function sumSessionSpend(limits: Map<AgentId, AgentCounters>): BudgetSpend {
	let costSpent = 0
	let tokensUsed = 0
	for (const counters of limits.values()) {
		costSpent += counters.costSpent
		tokensUsed += counters.tokensUsed
	}
	return { costSpent, tokensUsed }
}

const OUTBOUND_COMMUNICATION_TOOLS = new Set(['send_message', 'tell_user'])

function isOutboundCommunicationOnly(toolCalls: Array<{ name: string }>): boolean {
	return toolCalls.length > 0 && toolCalls.every((toolCall) => OUTBOUND_COMMUNICATION_TOOLS.has(toolCall.name))
}

/**
 * Extract agent counters from session state (for external consumers).
 */
export function selectAgentCounters(sessionState: SessionState, agentId: AgentId): AgentCounters {
	return selectPluginState<Map<AgentId, AgentCounters>>(sessionState, 'agentLimits')?.get(agentId) ?? createAgentCounters()
}

// ============================================================================
// Limit warning event
// ============================================================================

import z from 'zod/v4'
import { agentIdSchema } from '~/core/agents/schema.js'
import { createEventsFactory } from '~/core/events/types.js'

export const limitsEvents = createEventsFactory({
	events: {
		limit_warning: z.object({
			agentId: agentIdSchema,
			limitName: z.string(),
			currentValue: z.number(),
			hardLimit: z.number(),
			message: z.string(),
		}),
		budget_exceeded: z.object({
			agentId: agentIdSchema,
			/** Whether the per-agent or the session-wide budget was hit. */
			scope: z.enum(['agent', 'session']),
			/** Which limit tripped: maxCost / maxTokens / maxSessionCost / maxSessionTokens. */
			limitName: z.string(),
			spent: z.number(),
			limit: z.number(),
			message: z.string(),
		}),
	},
})

export type LimitWarningEvent = (typeof limitsEvents)['Events']['limit_warning']
export type BudgetExceededEvent = (typeof limitsEvents)['Events']['budget_exceeded']

// ============================================================================
// Helper
// ============================================================================

/**
 * Resolve tool name from agent state for tool_completed/tool_failed events.
 * Must run BEFORE core reducer (which clears executingToolCall).
 */
function resolveToolName(
	sessionState: { agents: Map<AgentId, { executingToolCall?: { toolName: string }; pendingToolCalls: Array<{ id: string; name: string }> }> },
	agentId: AgentId,
	toolCallId: string,
): string {
	const agent = sessionState.agents.get(agentId)
	if (!agent) return 'unknown'
	return agent.executingToolCall?.toolName
		?? agent.pendingToolCalls.find((tc) => tc.id === toolCallId)?.name
		?? 'unknown'
}

// ============================================================================
// Plugin
// ============================================================================

export interface LimitsAgentConfig {
	limits?: AgentLimits
}

export const limitsGuardPlugin = definePlugin('limits-guard')
	.events([agentEvents, llmEvents, toolEvents, mailboxEvents, contextEvents, limitsEvents])
	.pluginConfig<LimitsSessionConfig>()
	.state({
		key: 'agentLimits',
		initial: (): Map<AgentId, AgentCounters> => new Map(),
		reduce: (limits, event, sessionState) => {
			switch (event.type) {
				case 'agent_spawned': {
					const newLimits = new Map(limits)
					newLimits.set(event.agentId, createAgentCounters())

					// Increment parent's spawnedAgentCount
					if (event.parentId) {
						const parentCounters = newLimits.get(event.parentId)
						if (parentCounters) {
							newLimits.set(event.parentId, {
								...parentCounters,
								spawnedAgentCount: parentCounters.spawnedAgentCount + 1,
							})
						}
					}

					return newLimits
				}

				case 'mailbox_message': {
					let newLimits = limits
					const recipientCounters = limits.get(event.toAgentId)
					if (recipientCounters?.consecutiveNoProgressTurns) {
						newLimits = new Map(limits)
						newLimits.set(event.toAgentId, {
							...recipientCounters,
							consecutiveNoProgressTurns: 0,
						})
					}

					// Increment sender's messagesSentCount if sender is an agent
					const senderAgentId = typeof event.message.from === 'string' && event.message.from !== 'user'
						? event.message.from
						: null
					if (!senderAgentId) return newLimits

					const senderCounters = newLimits.get(AgentId(senderAgentId))
					if (!senderCounters) return newLimits

					if (newLimits === limits) newLimits = new Map(limits)
					newLimits.set(AgentId(senderAgentId), {
						...senderCounters,
						messagesSentCount: senderCounters.messagesSentCount + 1,
					})
					return newLimits
				}

				case 'inference_completed': {
					const counters = limits.get(event.agentId)
					if (!counters) return limits

					const hasToolCalls = event.response.toolCalls.length > 0
					const communicationOnly = isOutboundCommunicationOnly(event.response.toolCalls)
					let newRecentResponseHashes = counters.recentResponseHashes

					if (!hasToolCalls) {
						const isWaiting = /^\s*WAITING\s*$/.test(event.response.content ?? '')
						if (!isWaiting) {
							const hash = responseFingerprint(event.response.content)
							newRecentResponseHashes = [...newRecentResponseHashes, hash].slice(-10)
						}
					}

					const newLimits = new Map(limits)
					newLimits.set(event.agentId, {
						...counters,
						inferenceCount: counters.inferenceCount + 1,
						costSpent: counters.costSpent + (event.metrics.cost ?? 0),
						tokensUsed: counters.tokensUsed + (event.metrics.totalTokens ?? 0),
						consecutiveNoProgressTurns: communicationOnly
							? counters.consecutiveNoProgressTurns + 1
							: 0,
						recentResponseHashes: newRecentResponseHashes,
					})
					return newLimits
				}

				case 'auxiliary_inference_completed': {
					// Side-channel calls (e.g. context compaction) are billed but don't
					// touch conversation state, so they count toward cost/token budgets
					// but NOT toward inferenceCount or the anti-looping response hashes.
					const counters = limits.get(event.agentId)
					if (!counters) return limits

					const newLimits = new Map(limits)
					newLimits.set(event.agentId, {
						...counters,
						costSpent: counters.costSpent + (event.metrics.cost ?? 0),
						tokensUsed: counters.tokensUsed + (event.metrics.totalTokens ?? 0),
					})
					return newLimits
				}

				case 'context_compacted': {
					const counters = limits.get(event.agentId)
					if (!counters) return limits

					const newLimits = new Map(limits)
					newLimits.set(event.agentId, {
						...counters,
						compactionCount: counters.compactionCount + 1,
					})
					return newLimits
				}

				case 'tool_started': {
					const counters = limits.get(event.agentId)
					if (!counters) return limits

					const fingerprint = toolCallFingerprint(event.toolName, event.input)
					const newLimits = new Map(limits)
					newLimits.set(event.agentId, {
						...counters,
						toolCallCount: counters.toolCallCount + 1,
						recentToolCallHashes: [...counters.recentToolCallHashes, fingerprint].slice(-20),
					})
					return newLimits
				}

				case 'tool_completed': {
					const counters = limits.get(event.agentId)
					if (!counters) return limits

					// Resolve tool name from agent state (must run before core clears executingToolCall)
					const toolName = resolveToolName(sessionState, event.agentId, event.toolCallId)
					const { [toolName]: _, ...restFailures } = counters.consecutiveToolFailures

					const newLimits = new Map(limits)
					newLimits.set(event.agentId, {
						...counters,
						consecutiveToolFailures: restFailures,
					})
					return newLimits
				}

				case 'tool_failed': {
					const counters = limits.get(event.agentId)
					if (!counters) return limits

					// Resolve tool name from agent state (must run before core clears executingToolCall)
					const toolName = resolveToolName(sessionState, event.agentId, event.toolCallId)
					const currentEntry = counters.consecutiveToolFailures[toolName]

					const newLimits = new Map(limits)
					newLimits.set(event.agentId, {
						...counters,
						consecutiveToolFailures: {
							...counters.consecutiveToolFailures,
							[toolName]: { count: (currentEntry?.count ?? 0) + 1, lastError: event.error },
						},
					})
					return newLimits
				}

				case 'agent_resumed': {
					const counters = limits.get(event.agentId)
					if (!counters) return limits

					// Reset the anti-looping counters so the agent can make progress
					// again. Budget spend (costSpent/tokensUsed) is deliberately NOT
					// reset — otherwise a per-agent or session cost cap could be bypassed
					// by repeatedly pausing and resuming. To grant more budget, raise the
					// configured limit instead.
					const newLimits = new Map(limits)
					newLimits.set(event.agentId, {
						...counters,
						inferenceCount: 0,
						toolCallCount: 0,
						spawnedAgentCount: 0,
						messagesSentCount: 0,
						consecutiveNoProgressTurns: 0,
						compactionCount: 0,
						consecutiveToolFailures: {},
						recentToolCallHashes: [],
						recentResponseHashes: [],
					})
					return newLimits
				}

				default:
					return limits
			}
		},
	})
	.agentConfig<LimitsAgentConfig>()
	.hook('beforeInference', async (ctx) => {
		// Budgets are enforced here (before the call) so an exhausted agent is
		// paused before spending more — cost/tokens of a call aren't known until
		// after it returns, so we stop the *next* call once the threshold is hit.
		const counters = ctx.pluginState.get(ctx.agentId)
		if (!counters) return null

		const agentLimits = resolveAgentLimits(ctx.pluginAgentConfig?.limits)
		const agentCheck = checkBudget(
			counters,
			agentLimits.maxCost,
			agentLimits.maxTokens,
			agentLimits.softLimitRatio,
			{ cost: 'maxCost', tokens: 'maxTokens' },
		)
		if (agentCheck.status === 'hard_limit') {
			await ctx.emitEvent(limitsEvents.create('budget_exceeded', {
				agentId: ctx.agentId,
				scope: 'agent',
				limitName: agentCheck.limitName,
				spent: agentCheck.currentValue,
				limit: agentCheck.hardLimit,
				message: agentCheck.reason,
			}))
			return { action: 'pause', reason: `Agent budget exceeded — ${agentCheck.reason}` }
		}

		const sessionLimits = resolveSessionLimits(ctx.pluginConfig)
		const sessionSpend = sumSessionSpend(ctx.pluginState)
		const sessionCheck = checkBudget(
			sessionSpend,
			sessionLimits.maxSessionCost,
			sessionLimits.maxSessionTokens,
			sessionLimits.softLimitRatio,
			{ cost: 'maxSessionCost', tokens: 'maxSessionTokens' },
		)
		if (sessionCheck.status === 'hard_limit') {
			await ctx.emitEvent(limitsEvents.create('budget_exceeded', {
				agentId: ctx.agentId,
				scope: 'session',
				limitName: sessionCheck.limitName,
				spent: sessionCheck.currentValue,
				limit: sessionCheck.hardLimit,
				message: sessionCheck.reason,
			}))
			return { action: 'pause', reason: `Session budget exceeded — ${sessionCheck.reason}` }
		}

		return null
	})
	.hook('afterInference', async (ctx) => {
		const resolvedLimits = resolveAgentLimits(ctx.pluginAgentConfig?.limits)
		const counters = ctx.pluginState.get(ctx.agentId)
		if (!counters) return null

		// The inference_completed event hasn't been emitted yet, so project
		// what the counters will be after it's processed by the reducer.
		const hasToolCalls = ctx.response.toolCalls.length > 0
		const communicationOnly = isOutboundCommunicationOnly(ctx.response.toolCalls)
		const projected: AgentCounters = {
			...counters,
			inferenceCount: counters.inferenceCount + 1,
			consecutiveNoProgressTurns: communicationOnly
				? counters.consecutiveNoProgressTurns + 1
				: 0,
			recentResponseHashes: hasToolCalls
				? counters.recentResponseHashes
				: [...counters.recentResponseHashes, responseFingerprint(ctx.response.content)].slice(-10),
		}

		const limitCheck = checkLimits(projected, resolvedLimits)

		if (limitCheck.status === 'hard_limit') {
			return { action: 'pause', reason: limitCheck.reason }
		}

		return null
	})
	.status((ctx) => {
		const resolvedLimits = resolveAgentLimits(ctx.pluginAgentConfig?.limits)
		const counters = ctx.pluginState.get(ctx.agentId)
		if (!counters) return null

		const parts: string[] = []

		// Consecutive failures of the same tool — surface from count=2, well before the
		// hard limit. The agent sees what it tried, how many times, and with what error,
		// so it can change strategy rather than blindly retry.
		for (const [toolName, entry] of Object.entries(counters.consecutiveToolFailures)) {
			if (entry.count >= 2) {
				const lastError = entry.lastError.length > 600
					? entry.lastError.slice(0, 600) + '… [truncated]'
					: entry.lastError
				parts.push(
					`⚠️ Tool "${toolName}" has failed ${entry.count} times in a row (hard limit: ${resolvedLimits.maxConsecutiveToolFailures}). `
						+ `Last error: ${lastError}\n`
						+ `Do NOT retry the same call again. Diagnose the root cause, change approach, or stop and report what you tried.`,
				)
			}
		}

		// Same tool call with identical arguments repeated — even successful calls
		// that produce no new information are a waste. Warn from 2 repeats.
		const repeatedCalls = countConsecutiveTailDuplicates(counters.recentToolCallHashes)
		if (repeatedCalls >= 2) {
			parts.push(
				`⚠️ You have called the same tool with identical arguments ${repeatedCalls} times in a row `
					+ `(hard limit: ${resolvedLimits.maxRepeatedToolCalls}). `
					+ `Either the call is idempotent (stop repeating it) or your approach isn't working (change strategy).`,
			)
		}

		// Existing counter-based soft warnings (maxTurns, maxToolCalls, etc.)
		const limitCheck = checkLimits(counters, resolvedLimits)
		if (limitCheck.status === 'soft_warning') {
			parts.push(
				`⚠️ Approaching ${limitCheck.limitName} limit: ${limitCheck.currentValue}/${limitCheck.hardLimit}. `
					+ `Wrap up your current task or you will be stopped.`,
			)
		}

		// Budget soft warnings — per-agent spend, then the session-wide budget.
		const agentBudget = checkBudget(
			counters,
			resolvedLimits.maxCost,
			resolvedLimits.maxTokens,
			resolvedLimits.softLimitRatio,
			{ cost: 'maxCost', tokens: 'maxTokens' },
		)
		if (agentBudget.status === 'soft_warning') {
			parts.push(`⚠️ ${agentBudget.message}. You will be paused when the budget is reached — wrap up.`)
		}

		const sessionLimits = resolveSessionLimits(ctx.pluginConfig)
		const sessionBudget = checkBudget(
			sumSessionSpend(ctx.pluginState),
			sessionLimits.maxSessionCost,
			sessionLimits.maxSessionTokens,
			sessionLimits.softLimitRatio,
			{ cost: 'maxSessionCost', tokens: 'maxSessionTokens' },
		)
		if (sessionBudget.status === 'soft_warning') {
			parts.push(`⚠️ Session-wide ${sessionBudget.message}.`)
		}

		return parts.length > 0 ? parts.join('\n\n') : null
	})
	.build()
