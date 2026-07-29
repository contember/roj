import { describe, expect, it } from 'bun:test'
import { checkBudget, checkLimits, resolveAgentLimits, resolveSessionLimits } from './limit-guard.js'
import { createAgentCounters } from './plugin.js'
import type { AgentCounters } from './plugin.js'

describe('resolveAgentLimits', () => {
	it('returns defaults when no config', () => {
		const limits = resolveAgentLimits()
		expect(limits.maxTurns).toBe(100)
		expect(limits.maxToolCalls).toBe(200)
		expect(limits.maxConsecutiveToolFailures).toBe(3)
		expect(limits.maxSpawnedAgents).toBe(10)
		expect(limits.maxMessagesSent).toBe(100)
		expect(limits.softLimitRatio).toBe(0.8)
		expect(limits.maxRepeatedToolCalls).toBe(3)
		expect(limits.maxRepeatedResponses).toBe(3)
		expect(limits.maxConsecutiveNoProgressTurns).toBe(3)
		// Budgets and compaction cap are opt-in (unlimited by default)
		expect(limits.maxCost).toBe(Number.POSITIVE_INFINITY)
		expect(limits.maxTokens).toBe(Number.POSITIVE_INFINITY)
		expect(limits.maxCompactions).toBe(Number.POSITIVE_INFINITY)
	})

	it('returns defaults when empty config', () => {
		const limits = resolveAgentLimits({})
		expect(limits.maxTurns).toBe(100)
	})

	it('overrides specific values', () => {
		const limits = resolveAgentLimits({ maxTurns: 10, maxToolCalls: 50 })
		expect(limits.maxTurns).toBe(10)
		expect(limits.maxToolCalls).toBe(50)
		expect(limits.maxSpawnedAgents).toBe(10) // default
	})
})

describe('checkLimits', () => {
	const defaultLimits = resolveAgentLimits()

	const makeCounters = (overrides: Partial<AgentCounters> = {}): AgentCounters => ({
		...createAgentCounters(),
		...overrides,
	})

	it('returns ok for fresh counters', () => {
		const result = checkLimits(makeCounters(), defaultLimits)
		expect(result.status).toBe('ok')
	})

	// --- Hard limits ---

	it('detects maxTurns hard limit', () => {
		const result = checkLimits(makeCounters({ inferenceCount: 100 }), defaultLimits)
		expect(result.status).toBe('hard_limit')
		if (result.status === 'hard_limit') {
			expect(result.limitName).toBe('maxTurns')
		}
	})

	it('detects maxToolCalls hard limit', () => {
		const result = checkLimits(makeCounters({ toolCallCount: 200 }), defaultLimits)
		expect(result.status).toBe('hard_limit')
		if (result.status === 'hard_limit') {
			expect(result.limitName).toBe('maxToolCalls')
		}
	})

	it('detects maxSpawnedAgents hard limit', () => {
		const result = checkLimits(makeCounters({ spawnedAgentCount: 10 }), defaultLimits)
		expect(result.status).toBe('hard_limit')
		if (result.status === 'hard_limit') {
			expect(result.limitName).toBe('maxSpawnedAgents')
		}
	})

	it('detects maxMessagesSent hard limit', () => {
		const result = checkLimits(makeCounters({ messagesSentCount: 100 }), defaultLimits)
		expect(result.status).toBe('hard_limit')
		if (result.status === 'hard_limit') {
			expect(result.limitName).toBe('maxMessagesSent')
		}
	})

	// --- Pattern-based hard limits ---

	it('detects repeated tool calls', () => {
		const result = checkLimits(
			makeCounters({ recentToolCallHashes: ['a:1', 'a:1', 'a:1'] }),
			defaultLimits,
		)
		expect(result.status).toBe('hard_limit')
		if (result.status === 'hard_limit') {
			expect(result.limitName).toBe('maxRepeatedToolCalls')
		}
	})

	it('does not trigger repeated tool calls for different hashes', () => {
		const result = checkLimits(
			makeCounters({ recentToolCallHashes: ['a:1', 'a:2', 'a:1'] }),
			defaultLimits,
		)
		expect(result.status).not.toBe('hard_limit')
	})

	it('detects repeated responses', () => {
		const result = checkLimits(
			makeCounters({ recentResponseHashes: ['abc', 'abc', 'abc'] }),
			defaultLimits,
		)
		expect(result.status).toBe('hard_limit')
		if (result.status === 'hard_limit') {
			expect(result.limitName).toBe('maxRepeatedResponses')
		}
	})

	it('detects consecutive no-progress turns', () => {
		const result = checkLimits(
			makeCounters({ consecutiveNoProgressTurns: 3 }),
			defaultLimits,
		)
		expect(result.status).toBe('hard_limit')
		if (result.status === 'hard_limit') {
			expect(result.limitName).toBe('maxConsecutiveNoProgressTurns')
			expect(result.reason).toContain('used only outbound communication')
		}
	})

	it('detects consecutive tool failures', () => {
		const result = checkLimits(
			makeCounters({ consecutiveToolFailures: { read_file: { count: 3, lastError: 'file not found' } } }),
			defaultLimits,
		)
		expect(result.status).toBe('hard_limit')
		if (result.status === 'hard_limit') {
			expect(result.limitName).toBe('maxConsecutiveToolFailures')
			expect(result.reason).toContain('file not found')
		}
	})

	it('does not trigger for tool failures below threshold', () => {
		const result = checkLimits(
			makeCounters({ consecutiveToolFailures: { read_file: { count: 2, lastError: 'file not found' } } }),
			defaultLimits,
		)
		expect(result.status).not.toBe('hard_limit')
	})

	// --- Soft limits ---

	it('detects soft limit warning for maxTurns', () => {
		const result = checkLimits(makeCounters({ inferenceCount: 80 }), defaultLimits)
		expect(result.status).toBe('soft_warning')
		if (result.status === 'soft_warning') {
			expect(result.limitName).toBe('maxTurns')
		}
	})

	it('detects soft limit warning for maxToolCalls', () => {
		const result = checkLimits(makeCounters({ toolCallCount: 160 }), defaultLimits)
		expect(result.status).toBe('soft_warning')
		if (result.status === 'soft_warning') {
			expect(result.limitName).toBe('maxToolCalls')
		}
	})

	// --- Priority: hard > soft > ok ---

	it('hard limit takes priority over soft warning', () => {
		const result = checkLimits(
			makeCounters({
				inferenceCount: 100, // hard
				toolCallCount: 160, // soft
			}),
			defaultLimits,
		)
		expect(result.status).toBe('hard_limit')
	})

	// --- Compaction limit ---

	it('detects maxCompactions hard limit', () => {
		const limits = resolveAgentLimits({ maxCompactions: 5 })
		const result = checkLimits(makeCounters({ compactionCount: 5 }), limits)
		expect(result.status).toBe('hard_limit')
		if (result.status === 'hard_limit') {
			expect(result.limitName).toBe('maxCompactions')
		}
	})

	it('does not cap compactions by default (unlimited)', () => {
		const result = checkLimits(makeCounters({ compactionCount: 9999 }), defaultLimits)
		expect(result.status).toBe('ok')
	})
})

describe('checkBudget', () => {
	const names = { cost: 'maxCost', tokens: 'maxTokens' }

	it('returns ok when under budget', () => {
		const result = checkBudget({ costSpent: 1, tokensUsed: 100 }, 5, 1000, 0.8, names)
		expect(result.status).toBe('ok')
	})

	it('returns ok when unlimited (Infinity)', () => {
		const result = checkBudget(
			{ costSpent: 1_000_000, tokensUsed: 1_000_000 },
			Number.POSITIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			0.8,
			names,
		)
		expect(result.status).toBe('ok')
	})

	it('detects cost hard limit', () => {
		const result = checkBudget({ costSpent: 5.01, tokensUsed: 0 }, 5, Number.POSITIVE_INFINITY, 0.8, names)
		expect(result.status).toBe('hard_limit')
		if (result.status === 'hard_limit') expect(result.limitName).toBe('maxCost')
	})

	it('detects token hard limit', () => {
		const result = checkBudget({ costSpent: 0, tokensUsed: 1000 }, Number.POSITIVE_INFINITY, 1000, 0.8, names)
		expect(result.status).toBe('hard_limit')
		if (result.status === 'hard_limit') expect(result.limitName).toBe('maxTokens')
	})

	it('emits soft warning approaching cost budget', () => {
		const result = checkBudget({ costSpent: 4.2, tokensUsed: 0 }, 5, Number.POSITIVE_INFINITY, 0.8, names)
		expect(result.status).toBe('soft_warning')
		if (result.status === 'soft_warning') expect(result.limitName).toBe('maxCost')
	})

	it('handles sub-dollar budgets without spurious warnings', () => {
		// floor-based logic would warn at $0 for a $0.50 budget — float-aware must not.
		const result = checkBudget({ costSpent: 0.1, tokensUsed: 0 }, 0.5, Number.POSITIVE_INFINITY, 0.8, names)
		expect(result.status).toBe('ok')
	})
})

describe('resolveSessionLimits', () => {
	it('defaults to unlimited', () => {
		const limits = resolveSessionLimits()
		expect(limits.maxSessionCost).toBe(Number.POSITIVE_INFINITY)
		expect(limits.maxSessionTokens).toBe(Number.POSITIVE_INFINITY)
		expect(limits.softLimitRatio).toBe(0.8)
	})

	it('overrides specific values', () => {
		const limits = resolveSessionLimits({ maxSessionCost: 10 })
		expect(limits.maxSessionCost).toBe(10)
		expect(limits.maxSessionTokens).toBe(Number.POSITIVE_INFINITY)
	})
})
