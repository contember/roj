/**
 * Conformance: agent status transitions in the shared projections MUST match the
 * core reducer in @roj-ai/sdk. The sdk cannot import the shared helper
 * (project-reference cycle: shared already references sdk for types), so the
 * transition logic exists twice — this test replays identical event sequences
 * through the core reducer and both projections and fails on any divergence.
 *
 * sdk modules are imported from source (../../sdk/src) rather than the package
 * entry so the comparison always runs against live code, not a stale dist build.
 * This file lives outside shared/src on purpose: `bun test` executes it, but it
 * is not part of the shared tsc project (rootDir: src).
 */
import { describe, expect, it } from 'bun:test'
import { AgentId } from '../../sdk/src/core/agents/schema.js'
import { agentEvents } from '../../sdk/src/core/agents/state.js'
import { withSessionId } from '../../sdk/src/core/events/test-helpers.js'
import { llmEvents } from '../../sdk/src/core/llm/state.js'
import { SessionId } from '../../sdk/src/core/sessions/schema.js'
import { coreReducer, createSessionState, getAgentState, sessionEvents } from '../../sdk/src/core/sessions/state.js'
import { ToolCallId } from '../../sdk/src/core/tools/schema.js'
import { toolEvents } from '../../sdk/src/core/tools/state.js'
import { applyEventToAgentDetail, createAgentDetailProjectionState } from '../src/projections/agent-detail-projection.js'
import { applyEventToAgentTree, createAgentTreeProjectionState } from '../src/projections/agent-tree-projection.js'
import type { ProjectionEvent } from '../src/projections/events.js'

const sessionId = SessionId('conformance')
const agentId = AgentId('orchestrator_1')

const metrics = { promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0, model: 'mock' }

const spawned = () =>
	withSessionId(sessionId, agentEvents.create('agent_spawned', { agentId, definitionName: 'orchestrator', parentId: null }))
const inferenceStarted = () =>
	withSessionId(sessionId, llmEvents.create('inference_started', {
		agentId,
		messages: [{ role: 'user', content: 'hi' }],
		consumedMessageIds: [],
	}))
const inferenceCompleted = (toolCallCount: number) =>
	withSessionId(sessionId, llmEvents.create('inference_completed', {
		agentId,
		consumedMessageIds: [],
		response: {
			content: toolCallCount === 0 ? 'done' : null,
			toolCalls: Array.from({ length: toolCallCount }, (_, i) => ({ id: ToolCallId(`tc${i}`), name: 'noop', input: {} })),
		},
		metrics,
	}))
const inferenceFailed = () =>
	withSessionId(sessionId, llmEvents.create('inference_failed', { agentId, error: 'boom' }))
const inferenceRetried = () =>
	withSessionId(sessionId, llmEvents.create('inference_retried', { agentId }))
const toolStarted = (i: number) =>
	withSessionId(sessionId, toolEvents.create('tool_started', { agentId, toolCallId: ToolCallId(`tc${i}`), toolName: 'noop', input: {} }))
const toolCompleted = (i: number) =>
	withSessionId(sessionId, toolEvents.create('tool_completed', { agentId, toolCallId: ToolCallId(`tc${i}`), result: 'ok' }))
const toolFailed = (i: number) =>
	withSessionId(sessionId, toolEvents.create('tool_failed', { agentId, toolCallId: ToolCallId(`tc${i}`), error: 'tool boom' }))
const paused = (reason: 'manual' | 'handler') =>
	withSessionId(sessionId, agentEvents.create('agent_paused', { agentId, reason }))
const resumed = () =>
	withSessionId(sessionId, agentEvents.create('agent_resumed', { agentId }))
const sessionRestarted = () =>
	withSessionId(sessionId, sessionEvents.create('session_restarted', { resetAgentIds: [agentId], clearedToolAgentIds: [] }))

/**
 * Replay the sequence through the core reducer and both projections, comparing
 * status and pending tool call count after every event.
 */
function expectConformance(events: ProjectionEvent[]): void {
	let core = createSessionState(sessionId, 'test-preset', 0)
	let tree = createAgentTreeProjectionState()
	let detail = createAgentDetailProjectionState()

	events.forEach((event, i) => {
		core = coreReducer(core, event)
		tree = applyEventToAgentTree(tree, event)
		detail = applyEventToAgentDetail(detail, event)

		const at = `after event #${i} (${event.type})`
		const coreAgent = getAgentState(core, agentId)
		const coreStatus = `${at}: status=${coreAgent?.status} pendingToolCalls=${coreAgent?.pendingToolCalls.length}`

		const treeAgent = tree.agents.get(agentId)
		expect(`${at}: status=${treeAgent?.status} pendingToolCalls=${treeAgent?.pendingToolCallCount}`).toBe(coreStatus)

		const detailAgent = detail.agents.get(agentId)
		expect(`${at}: status=${detailAgent?.status} pendingToolCalls=${detailAgent?.pendingToolCalls.length}`).toBe(coreStatus)
	})
}

describe('shared projections: agent status conformance with core reducer', () => {
	it('plain turn without tool calls', () => {
		expectConformance([spawned(), inferenceStarted(), inferenceCompleted(0)])
	})

	it('tool turn: pause from a tool hook mid-turn, resume finishes the remaining tools', () => {
		expectConformance([
			spawned(),
			inferenceStarted(),
			inferenceCompleted(2),
			toolStarted(0),
			paused('handler'),
			toolCompleted(0),
			resumed(),
			toolStarted(1),
			toolCompleted(1),
			inferenceStarted(),
			inferenceCompleted(0),
		])
	})

	it('tool turn: failing tool while paused', () => {
		expectConformance([
			spawned(),
			inferenceStarted(),
			inferenceCompleted(2),
			toolStarted(0),
			paused('handler'),
			toolFailed(0),
			resumed(),
			toolStarted(1),
			toolFailed(1),
		])
	})

	it('manual pause during in-flight inference survives the commit', () => {
		expectConformance([
			spawned(),
			inferenceStarted(),
			paused('manual'),
			inferenceCompleted(2),
			resumed(),
			toolStarted(0),
			toolCompleted(0),
			toolStarted(1),
			toolCompleted(1),
		])
	})

	it('afterInference retry rolls back and re-runs the turn', () => {
		expectConformance([
			spawned(),
			inferenceStarted(),
			inferenceRetried(),
			inferenceStarted(),
			inferenceCompleted(0),
		])
	})

	it('retry while paused preserves the pause', () => {
		expectConformance([
			spawned(),
			inferenceStarted(),
			paused('manual'),
			inferenceRetried(),
			resumed(),
			inferenceStarted(),
			inferenceCompleted(0),
		])
	})

	it('inference failure and manual resume', () => {
		expectConformance([
			spawned(),
			inferenceStarted(),
			inferenceFailed(),
			resumed(),
			inferenceStarted(),
			inferenceCompleted(0),
		])
	})

	it('inference failure and session restart', () => {
		expectConformance([
			spawned(),
			inferenceStarted(),
			inferenceFailed(),
			sessionRestarted(),
			inferenceStarted(),
			inferenceCompleted(0),
		])
	})

	it('session restart during in-flight inference', () => {
		expectConformance([
			spawned(),
			inferenceStarted(),
			sessionRestarted(),
			inferenceStarted(),
			inferenceCompleted(0),
		])
	})
})
