import { describe, expect, it } from 'bun:test'
import { checkLimits, resolveAgentLimits } from './limit-guard.js'
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
})
