/**
 * Limit guard - checks agent counters against configured limits.
 *
 * Returns the worst result: hard_limit > soft_warning > ok.
 */

import type { AgentLimits, LimitsSessionConfig } from '~/plugins/limits-guard/config.js'
import type { AgentCounters } from './plugin.js'

// ============================================================================
// Resolved limits (all fields required with defaults)
// ============================================================================

export interface ResolvedAgentLimits {
	maxTurns: number
	maxToolCalls: number
	maxConsecutiveToolFailures: number
	maxSpawnedAgents: number
	maxMessagesSent: number
	softLimitRatio: number
	maxRepeatedToolCalls: number
	maxRepeatedResponses: number
	maxConsecutiveNoProgressTurns: number
	maxCost: number
	maxTokens: number
	maxCompactions: number
}

const DEFAULTS: ResolvedAgentLimits = {
	maxTurns: 100,
	maxToolCalls: 200,
	maxConsecutiveToolFailures: 3,
	maxSpawnedAgents: 10,
	maxMessagesSent: 100,
	softLimitRatio: 0.8,
	maxRepeatedToolCalls: 3,
	maxRepeatedResponses: 3,
	maxConsecutiveNoProgressTurns: 3,
	// Budgets and the compaction cap are opt-in: unset means unlimited.
	maxCost: Number.POSITIVE_INFINITY,
	maxTokens: Number.POSITIVE_INFINITY,
	maxCompactions: Number.POSITIVE_INFINITY,
}

export function resolveAgentLimits(config?: AgentLimits): ResolvedAgentLimits {
	if (!config) return DEFAULTS
	return {
		maxTurns: config.maxTurns ?? DEFAULTS.maxTurns,
		maxToolCalls: config.maxToolCalls ?? DEFAULTS.maxToolCalls,
		maxConsecutiveToolFailures: config.maxConsecutiveToolFailures ?? DEFAULTS.maxConsecutiveToolFailures,
		maxSpawnedAgents: config.maxSpawnedAgents ?? DEFAULTS.maxSpawnedAgents,
		maxMessagesSent: config.maxMessagesSent ?? DEFAULTS.maxMessagesSent,
		softLimitRatio: config.softLimitRatio ?? DEFAULTS.softLimitRatio,
		maxRepeatedToolCalls: config.maxRepeatedToolCalls ?? DEFAULTS.maxRepeatedToolCalls,
		maxRepeatedResponses: config.maxRepeatedResponses ?? DEFAULTS.maxRepeatedResponses,
		maxConsecutiveNoProgressTurns:
			config.maxConsecutiveNoProgressTurns ?? DEFAULTS.maxConsecutiveNoProgressTurns,
		maxCost: config.maxCost ?? DEFAULTS.maxCost,
		maxTokens: config.maxTokens ?? DEFAULTS.maxTokens,
		maxCompactions: config.maxCompactions ?? DEFAULTS.maxCompactions,
	}
}

// ============================================================================
// Session budget
// ============================================================================

export interface ResolvedSessionLimits {
	maxSessionCost: number
	maxSessionTokens: number
	softLimitRatio: number
}

const SESSION_DEFAULTS: ResolvedSessionLimits = {
	maxSessionCost: Number.POSITIVE_INFINITY,
	maxSessionTokens: Number.POSITIVE_INFINITY,
	softLimitRatio: 0.8,
}

export function resolveSessionLimits(config?: LimitsSessionConfig): ResolvedSessionLimits {
	if (!config) return SESSION_DEFAULTS
	return {
		maxSessionCost: config.maxSessionCost ?? SESSION_DEFAULTS.maxSessionCost,
		maxSessionTokens: config.maxSessionTokens ?? SESSION_DEFAULTS.maxSessionTokens,
		softLimitRatio: config.softLimitRatio ?? SESSION_DEFAULTS.softLimitRatio,
	}
}

/** Cumulative spend, either for a single agent or summed across the session. */
export interface BudgetSpend {
	costSpent: number
	tokensUsed: number
}

/**
 * Budget check (cost + tokens) shared by per-agent and session-wide budgets.
 *
 * Kept separate from {@link checkLimits} so it can run in `beforeInference` —
 * blocking the *next* call once the budget is exhausted — without also tripping
 * the counter/pattern limits (those are enforced in `afterInference`). Uses
 * float-aware comparisons (no flooring) so sub-dollar budgets behave correctly.
 */
export function checkBudget(
	spend: BudgetSpend,
	costLimit: number,
	tokenLimit: number,
	softLimitRatio: number,
	names: { cost: string; tokens: string },
): LimitCheckResult {
	const checks: Array<{ name: string; current: number; max: number }> = [
		{ name: names.cost, current: spend.costSpent, max: costLimit },
		{ name: names.tokens, current: spend.tokensUsed, max: tokenLimit },
	]

	// Hard limits
	for (const check of checks) {
		if (check.current >= check.max) {
			return {
				status: 'hard_limit',
				limitName: check.name,
				currentValue: check.current,
				hardLimit: check.max,
				reason: `${check.name} reached: ${formatBudget(check.current)}/${formatBudget(check.max)}`,
			}
		}
	}

	// Soft warnings
	for (const check of checks) {
		if (check.max !== Number.POSITIVE_INFINITY && check.current >= check.max * softLimitRatio) {
			return {
				status: 'soft_warning',
				limitName: check.name,
				currentValue: check.current,
				hardLimit: check.max,
				message: `Approaching ${check.name} limit: ${formatBudget(check.current)}/${formatBudget(check.max)}`,
			}
		}
	}

	return { status: 'ok' }
}

/** Format a budget value compactly — 4 decimals for fractional (cost), integer otherwise. */
function formatBudget(value: number): string {
	if (value === Number.POSITIVE_INFINITY) return '∞'
	return Number.isInteger(value) ? String(value) : value.toFixed(4)
}

// ============================================================================
// Check result
// ============================================================================

export type LimitCheckResult =
	| { status: 'ok' }
	| { status: 'soft_warning'; limitName: string; currentValue: number; hardLimit: number; message: string }
	| { status: 'hard_limit'; limitName: string; currentValue: number; hardLimit: number; reason: string }

// ============================================================================
// Check logic
// ============================================================================

export function checkLimits(counters: AgentCounters, limits: ResolvedAgentLimits): LimitCheckResult {
	// --- Hard limits (counter-based) ---

	const hardChecks: Array<{ name: string; current: number; max: number }> = [
		{ name: 'maxTurns', current: counters.inferenceCount, max: limits.maxTurns },
		{ name: 'maxToolCalls', current: counters.toolCallCount, max: limits.maxToolCalls },
		{ name: 'maxSpawnedAgents', current: counters.spawnedAgentCount, max: limits.maxSpawnedAgents },
		{ name: 'maxMessagesSent', current: counters.messagesSentCount, max: limits.maxMessagesSent },
		{ name: 'maxCompactions', current: counters.compactionCount, max: limits.maxCompactions },
		{
			name: 'maxConsecutiveNoProgressTurns',
			current: counters.consecutiveNoProgressTurns,
			max: limits.maxConsecutiveNoProgressTurns,
		},
	]

	for (const check of hardChecks) {
		if (check.current >= check.max) {
			const reason = check.name === 'maxConsecutiveNoProgressTurns'
				? `No progress detected: ${check.current} consecutive turns used only outbound communication`
				: `${check.name} reached: ${check.current}/${check.max}`
			return {
				status: 'hard_limit',
				limitName: check.name,
				currentValue: check.current,
				hardLimit: check.max,
				reason,
			}
		}
	}

	// --- Hard limits (pattern-based) ---

	// Consecutive identical tool calls
	const repeatedToolCalls = countConsecutiveTailDuplicates(counters.recentToolCallHashes)
	if (repeatedToolCalls >= limits.maxRepeatedToolCalls) {
		return {
			status: 'hard_limit',
			limitName: 'maxRepeatedToolCalls',
			currentValue: repeatedToolCalls,
			hardLimit: limits.maxRepeatedToolCalls,
			reason: `Repeated identical tool call detected (${repeatedToolCalls} times)`,
		}
	}

	// Consecutive identical responses
	const repeatedResponses = countConsecutiveTailDuplicates(counters.recentResponseHashes)
	if (repeatedResponses >= limits.maxRepeatedResponses) {
		return {
			status: 'hard_limit',
			limitName: 'maxRepeatedResponses',
			currentValue: repeatedResponses,
			hardLimit: limits.maxRepeatedResponses,
			reason: `Repeated identical response detected (${repeatedResponses} times)`,
		}
	}

	// Consecutive tool failures (any tool)
	for (const [toolName, entry] of Object.entries(counters.consecutiveToolFailures)) {
		if (entry.count >= limits.maxConsecutiveToolFailures) {
			return {
				status: 'hard_limit',
				limitName: 'maxConsecutiveToolFailures',
				currentValue: entry.count,
				hardLimit: limits.maxConsecutiveToolFailures,
				reason: `Tool '${toolName}' failed ${entry.count} consecutive times. Last error: ${entry.lastError}`,
			}
		}
	}

	// --- Soft limits (counter-based) ---

	const softThreshold = limits.softLimitRatio

	for (const check of hardChecks) {
		const threshold = Math.floor(check.max * softThreshold)
		if (check.current >= threshold) {
			return {
				status: 'soft_warning',
				limitName: check.name,
				currentValue: check.current,
				hardLimit: check.max,
				message: `Approaching ${check.name} limit: ${check.current}/${check.max}`,
			}
		}
	}

	return { status: 'ok' }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Count how many consecutive identical items appear at the end of an array.
 * Returns 1 if the last item is unique, 0 if array is empty.
 */
export function countConsecutiveTailDuplicates(arr: string[]): number {
	if (arr.length === 0) return 0
	const last = arr[arr.length - 1]
	let count = 0
	for (let i = arr.length - 1; i >= 0; i--) {
		if (arr[i] === last) {
			count++
		} else {
			break
		}
	}
	return count
}
