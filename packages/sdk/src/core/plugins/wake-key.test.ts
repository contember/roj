import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { SessionId } from '~/core/sessions/schema.js'
import { parsePluginWakeKey, pluginWakeKey } from './wake-key.js'

const sessionId = SessionId('0195f0a1-0000-7000-8000-000000000001')
const agentId = AgentId('orchestrator_1')

describe('plugin wake keys', () => {
	it('round-trips with and without an agent', () => {
		expect(parsePluginWakeKey(pluginWakeKey(sessionId, 'agents', '_supervisionTick', agentId)))
			.toEqual({ sessionId, pluginName: 'agents', method: '_supervisionTick', agentId })
		expect(parsePluginWakeKey(pluginWakeKey(sessionId, 'git-status', 'refresh')))
			.toEqual({ sessionId, pluginName: 'git-status', method: 'refresh' })
	})

	it('uses the documented shape', () => {
		expect(pluginWakeKey(sessionId, 'agents', '_supervisionTick', agentId))
			.toBe(`plugin:${sessionId}:agents:_supervisionTick:${agentId}`)
	})

	it('round-trips segments containing the separator', () => {
		const awkward = SessionId('tenant:acme')
		const key = pluginWakeKey(awkward, 'git:status', 'refresh:now', AgentId('worker:2'))
		expect(key.split(':')).toHaveLength(5)
		expect(parsePluginWakeKey(key))
			.toEqual({ sessionId: awkward, pluginName: 'git:status', method: 'refresh:now', agentId: AgentId('worker:2') })
	})

	it('rejects keys it did not mint', () => {
		const notOurs = [
			'',
			'plugin',
			'plugin:s1:agents',
			'plugin:s1:agents:tick:a1:extra',
			'agent:s1:a1:debounce',
			'plugin::agents:tick',
			'plugin:s1::tick',
			'plugin:s1:agents:',
			'plugin:s1:agents:tick:',
			'plugin:%E0%A4%A:agents:tick',
		]
		for (const key of notOurs) {
			expect(parsePluginWakeKey(key)).toBeUndefined()
		}
	})
})
