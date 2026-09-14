import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { DomainEvent } from '~/core/events/types.js'
import { createApplyEvent } from '~/core/sessions/apply-event.js'
import { SessionId } from '~/core/sessions/schema.js'
import { createSessionState, sessionEvents } from '~/core/sessions/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { toolEvents } from '~/core/tools/state.js'
import { limitsGuardPlugin, selectAgentCounters } from './plugin.js'
import { checkLimits, resolveAgentLimits } from './limit-guard.js'

const sessionId = SessionId('limits-recovery')
const agentId = AgentId('worker')
const applyEvent = createApplyEvent([limitsGuardPlugin.create({})])
const spawn = withSessionId(
	sessionId,
	agentEvents.create('agent_spawned', {
		agentId,
		definitionName: 'worker',
		parentId: null,
	}),
)
const start = (id: string) =>
	withSessionId(
		sessionId,
		toolEvents.create('tool_started', {
			agentId,
			toolCallId: ToolCallId(id),
			toolName: 'run_command',
			input: { command: 'sleep 60' },
		}),
	)
const restart = withSessionId(
	sessionId,
	sessionEvents.create('session_restarted', {
		resetAgentIds: [],
		clearedToolAgentIds: [agentId],
	}),
)
const counters = (events: DomainEvent[]) => selectAgentCounters(events.reduce(applyEvent, createSessionState(sessionId, 'test', 0)), agentId)

describe('limits during tool recovery', () => {
	it('counts one in-flight call once across repeated restart events and replay', () => {
		const events = [spawn, start('call-1'), restart, start('call-1'), restart, start('call-1'), restart, start('call-1')]
		const result = counters(events)
		expect(result.toolCallCount).toBe(1)
		expect(result.recentToolCallHashes).toHaveLength(1)
		expect(checkLimits(result, resolveAgentLimits()).status).toBe('ok')
		expect(counters(events)).toEqual(result)
	})

	it('still counts completed identical calls as separate work', () => {
		const events: DomainEvent[] = [spawn]
		for (let i = 0; i < 4; i++) {
			const id = ToolCallId(`call-${i}`)
			events.push(
				start(id),
				withSessionId(
					sessionId,
					toolEvents.create('tool_completed', {
						agentId,
						toolCallId: id,
						result: 'done',
					}),
				),
			)
		}
		const result = counters(events)
		expect(result.toolCallCount).toBe(4)
		expect(result.recentToolCallHashes).toHaveLength(4)
		expect(new Set(result.recentToolCallHashes).size).toBe(1)
		expect(checkLimits(result, resolveAgentLimits())).toMatchObject({ status: 'hard_limit', limitName: 'maxRepeatedToolCalls' })
	})

	it('clears the unfinished-call marker on failure without losing failure accounting', () => {
		const result = counters([
			spawn,
			start('call-1'),
			restart,
			start('call-1'),
			withSessionId(
				sessionId,
				toolEvents.create('tool_failed', {
					agentId,
					toolCallId: ToolCallId('call-1'),
					error: 'command failed',
				}),
			),
		])
		expect(result.toolCallCount).toBe(1)
		expect(result.countedToolCallId).toBeUndefined()
		expect(Object.values(result.consecutiveToolFailures)).toEqual([{ count: 1, lastError: 'command failed' }])
	})
})
