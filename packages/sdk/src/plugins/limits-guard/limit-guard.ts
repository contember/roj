/**
 * Limit guard - checks agent counters against configured limits.
 *
 * Returns the worst result: hard_limit > soft_warning > ok.
 */

import type { AgentLimits } from '~/plugins/limits-guard/config.js'
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
	}
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
	]

	for (const check of hardChecks) {
		if (check.current >= check.max) {
			return {
				status: 'hard_limit',
				limitName: check.name,
				currentValue: check.current,
				hardLimit: check.max,
				reason: `${check.name} reached: ${check.current}/${check.max}`,
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
