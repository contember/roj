import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { DomainEvent } from '~/core/events/types.js'
import { createApplyEvent } from '~/core/sessions/apply-event.js'
import { SessionId } from '~/core/sessions/schema.js'
import { createSessionState } from '~/core/sessions/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { toolEvents } from '~/core/tools/state.js'
import { checkLimits, resolveAgentLimits } from './limit-guard.js'
import { limitsGuardPlugin, selectAgentCounters } from './plugin.js'

const sessionId = SessionId('limits-tool-failures')
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

const call = (id: string, toolName: string, outcome: 'completed' | 'failed'): DomainEvent[] => [
	withSessionId(
		sessionId,
		toolEvents.create('tool_started', {
			agentId,
			toolCallId: ToolCallId(id),
			toolName,
			input: {},
		}),
	),
	outcome === 'completed'
		? withSessionId(sessionId, toolEvents.create('tool_completed', { agentId, toolCallId: ToolCallId(id), result: 'ok' }))
		: withSessionId(sessionId, toolEvents.create('tool_failed', { agentId, toolCallId: ToolCallId(id), error: `${toolName} failed` })),
]

const counters = (events: DomainEvent[]) => selectAgentCounters(events.reduce(applyEvent, createSessionState(sessionId, 'test', 0)), agentId)

describe('consecutive tool failures', () => {
	it('counts failures under the failing tool name', () => {
		const result = counters([spawn, ...call('call-1', 'run_command', 'failed'), ...call('call-2', 'run_command', 'failed')])

		expect(result.consecutiveToolFailures).toEqual({ run_command: { count: 2, lastError: 'run_command failed' } })
	})

	it('keeps counting a failing tool across successes of another tool', () => {
		const result = counters([
			spawn,
			...call('call-1', 'run_command', 'failed'),
			...call('call-2', 'read_file', 'completed'),
			...call('call-3', 'run_command', 'failed'),
			...call('call-4', 'read_file', 'completed'),
			...call('call-5', 'run_command', 'failed'),
		])

		expect(result.consecutiveToolFailures).toEqual({ run_command: { count: 3, lastError: 'run_command failed' } })
		expect(checkLimits(result, resolveAgentLimits({ maxConsecutiveToolFailures: 3, maxRepeatedToolCalls: 10 }))).toMatchObject({
			status: 'hard_limit',
			limitName: 'maxConsecutiveToolFailures',
			currentValue: 3,
		})
	})

	it('resets the count when the same tool succeeds', () => {
		const result = counters([
			spawn,
			...call('call-1', 'run_command', 'failed'),
			...call('call-2', 'run_command', 'failed'),
			...call('call-3', 'run_command', 'completed'),
		])

		expect(result.consecutiveToolFailures).toEqual({})
	})
})
