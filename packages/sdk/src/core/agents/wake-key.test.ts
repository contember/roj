import { describe, expect, it } from 'bun:test'
import { SessionId } from '~/core/sessions/schema.js'
import { AgentId } from './schema.js'
import { agentWakeKey, parseAgentWakeKey } from './wake-key.js'

const sessionId = SessionId('0195f0a1-0000-7000-8000-000000000001')
const agentId = AgentId('orchestrator_1')

describe('agent wake keys', () => {
	it('round-trips every kind', () => {
		for (const kind of ['debounce', 'retry'] as const) {
			const key = agentWakeKey(sessionId, agentId, kind)
			expect(parseAgentWakeKey(key)).toEqual({ sessionId, agentId, kind })
		}
	})

	it('uses the documented shape', () => {
		expect(agentWakeKey(sessionId, agentId, 'debounce')).toBe(`agent:${sessionId}:${agentId}:debounce`)
	})

	it('round-trips ids containing the separator', () => {
		// createSession takes any string as a sessionId, so a `:` reaches this code.
		const awkward = SessionId('tenant:acme/session 1')
		const key = agentWakeKey(awkward, AgentId('worker:2'), 'retry')
		expect(key.split(':')).toHaveLength(4)
		expect(parseAgentWakeKey(key)).toEqual({ sessionId: awkward, agentId: AgentId('worker:2'), kind: 'retry' })
	})

	it('rejects keys it did not mint', () => {
		const notOurs = [
			'',
			'agent',
			'agent:s1:a1',
			'agent:s1:a1:debounce:extra',
			'services:s1:a1:debounce',
			'agent:s1:a1:supervise',
			'agent::a1:debounce',
			'agent:s1::debounce',
			'agent:%E0%A4%A:a1:debounce',
		]
		for (const key of notOurs) {
			expect(parseAgentWakeKey(key)).toBeUndefined()
		}
	})
})
