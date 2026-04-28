import { AgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { DomainEvent, FactoryEventType } from '~/core/events/types.js'
import { SessionId } from '~/core/sessions/schema.js'
import { sessionEvents } from '~/core/sessions/state.js'
import type { SessionCreatedEvent } from '~/core/sessions/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { toolEvents } from '~/core/tools/state.js'

type ToolEvent = FactoryEventType<typeof toolEvents>
import { describe, expect, it } from 'bun:test'
import { findSnapshotRefsAtIndex, rewriteEventsForFork } from './fork-utils.js'

const sourceSessionId = SessionId('source-session-id')
const newSessionId = SessionId('new-session-id')
const agentId = AgentId('agent-1')

function makeEvents(): DomainEvent[] {
	return [
		{
			...withSessionId(
				sourceSessionId,
				sessionEvents.create('session_created', {
					presetId: 'test-preset',
					workspaceDir: '/workspace/source',
				}),
			),
			timestamp: 1000,
		},
		{
			...withSessionId(
				sourceSessionId,
				agentEvents.create('agent_spawned', {
					agentId,
					definitionName: 'orchestrator',
					parentId: null,
				}),
			),
			timestamp: 1001,
		},
		{
			...withSessionId(
				sourceSessionId,
				toolEvents.create('tool_completed', {
					agentId,
					toolCallId: ToolCallId('tc-1'),
					result: 'done',
					sessionRef: 'session-ref-1',
					workspaceRef: 'workspace-ref-1',
				}),
			),
			timestamp: 1002,
		},
		{
			...withSessionId(
				sourceSessionId,
				toolEvents.create('tool_completed', {
					agentId,
					toolCallId: ToolCallId('tc-2'),
					result: 'done again',
					sessionRef: 'session-ref-2',
				}),
			),
			timestamp: 1003,
		},
		{
			...withSessionId(
				sourceSessionId,
				toolEvents.create('tool_failed', {
					agentId,
					toolCallId: ToolCallId('tc-3'),
					error: 'oops',
					workspaceRef: 'workspace-ref-3',
					sessionRef: 'session-ref-3',
				}),
			),
			timestamp: 1004,
		},
	]
}

describe('rewriteEventsForFork', () => {
	it('slices events up to eventIndex inclusive', () => {
		const events = makeEvents()
		const result = rewriteEventsForFork(events, 2, newSessionId, sourceSessionId)
		expect(result).toHaveLength(3)
	})

	it('rewrites sessionId on all events', () => {
		const events = makeEvents()
		const result = rewriteEventsForFork(events, 2, newSessionId, sourceSessionId)
		for (const event of result) {
			expect(event.sessionId).toBe(newSessionId)
		}
	})

	it('adds forkedFrom to session_created event', () => {
		const events = makeEvents()
		const result = rewriteEventsForFork(events, 2, newSessionId, sourceSessionId)
		const created = result[0] as SessionCreatedEvent
		expect(created.type).toBe('session_created')
		expect(created.forkedFrom).toEqual({
			sessionId: sourceSessionId,
			eventIndex: 2,
		})
	})

	it('preserves all other event fields', () => {
		const events = makeEvents()
		const result = rewriteEventsForFork(events, 2, newSessionId, sourceSessionId)
		const toolEvent = result[2] as ToolEvent
		expect(toolEvent.type).toBe('tool_completed')
		if (toolEvent.type === 'tool_completed') {
			expect(toolEvent.sessionRef).toBe('session-ref-1')
			expect(toolEvent.workspaceRef).toBe('workspace-ref-1')
			expect(toolEvent.result).toBe('done')
		}
	})

	it('handles eventIndex 0 (only session_created)', () => {
		const events = makeEvents()
		const result = rewriteEventsForFork(events, 0, newSessionId, sourceSessionId)
		expect(result).toHaveLength(1)
		expect(result[0].type).toBe('session_created')
	})
})

describe('findSnapshotRefsAtIndex', () => {
	it('finds the most recent refs scanning backwards', () => {
		const events = makeEvents()
		const refs = findSnapshotRefsAtIndex(events, 4)
		expect(refs.sessionRef).toBe('session-ref-3')
		expect(refs.workspaceRef).toBe('workspace-ref-3')
	})

	it('finds refs at exact index', () => {
		const events = makeEvents()
		const refs = findSnapshotRefsAtIndex(events, 2)
		expect(refs.sessionRef).toBe('session-ref-1')
		expect(refs.workspaceRef).toBe('workspace-ref-1')
	})

	it('falls back to earlier events for missing refs', () => {
		const events = makeEvents()
		// Event 3 has sessionRef but no workspaceRef, should fall back to event 2 for workspaceRef
		const refs = findSnapshotRefsAtIndex(events, 3)
		expect(refs.sessionRef).toBe('session-ref-2')
		expect(refs.workspaceRef).toBe('workspace-ref-1')
	})

	it('returns undefined refs when no events have them', () => {
		const events = makeEvents()
		const refs = findSnapshotRefsAtIndex(events, 1)
		expect(refs.sessionRef).toBeUndefined()
		expect(refs.workspaceRef).toBeUndefined()
	})
})
