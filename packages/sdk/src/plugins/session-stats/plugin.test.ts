import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { contextEvents } from '~/core/context/state.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { DomainEvent } from '~/core/events/types.js'
import type { LLMMetrics } from '~/core/llm/state.js'
import { llmEvents } from '~/core/llm/state.js'
import { createApplyEvent } from '~/core/sessions/apply-event.js'
import { SessionId } from '~/core/sessions/schema.js'
import { createSessionState } from '~/core/sessions/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { toolEvents } from '~/core/tools/state.js'
import { userChatEvents } from '~/plugins/user-chat/plugin.js'
import { ChatMessageId } from '~/plugins/user-chat/schema.js'
import { selectSessionStats, sessionStatsPlugin } from './plugin.js'

const sessionId = SessionId('session-stats-test')
const orchestrator = AgentId('orchestrator-1')
const worker = AgentId('worker-1')

const applyEvent = createApplyEvent([sessionStatsPlugin.create()])

const metrics = (overrides: Partial<LLMMetrics> = {}): LLMMetrics => ({
	promptTokens: 100,
	completionTokens: 20,
	totalTokens: 120,
	latencyMs: 10,
	model: 'test-model',
	provider: 'anthropic',
	cost: 0.5,
	...overrides,
})

const spawn = (agentId: AgentId, definitionName: string) =>
	withSessionId(sessionId, agentEvents.create('agent_spawned', { agentId, definitionName, parentId: null }))

const inference = (agentId: AgentId, m: LLMMetrics) =>
	withSessionId(sessionId, llmEvents.create('inference_completed', {
		agentId,
		consumedMessageIds: [],
		response: { content: 'ok', toolCalls: [] },
		metrics: m,
	}))

const reduce = (events: DomainEvent[]) => selectSessionStats(events.reduce(applyEvent, createSessionState(sessionId, 'test-preset', 0)))

describe('session-stats plugin', () => {
	it('starts from zeroed counters', () => {
		const stats = reduce([])
		expect(stats.userMessages).toBe(0)
		expect(stats.compactions).toBe(0)
		expect(stats.cacheReadTokens).toBe(0)
		expect(stats.cacheWriteTokens).toBe(0)
		expect(stats.byAgent).toEqual({})
	})

	it('counts user chat messages', () => {
		const stats = reduce([
			spawn(orchestrator, 'orchestrator'),
			withSessionId(sessionId, userChatEvents.create('user_chat_message_received', {
				agentId: orchestrator,
				messageId: ChatMessageId('m1'),
				content: 'hello',
				timestamp: 1,
			})),
			withSessionId(sessionId, userChatEvents.create('user_chat_message_received', {
				agentId: orchestrator,
				messageId: ChatMessageId('m2'),
				content: 'again',
				timestamp: 2,
			})),
		])
		expect(stats.userMessages).toBe(2)
	})

	it('counts context compactions', () => {
		const stats = reduce([
			spawn(orchestrator, 'orchestrator'),
			withSessionId(sessionId, contextEvents.create('context_compacted', {
				agentId: orchestrator,
				compactedContent: 'summary',
				newConversationHistory: [],
				originalTokens: 1000,
				compactedTokens: 100,
				messagesRemoved: 8,
			})),
		])
		expect(stats.compactions).toBe(1)
	})

	it('sums cache read and write tokens across main and auxiliary inferences', () => {
		const stats = reduce([
			spawn(orchestrator, 'orchestrator'),
			inference(orchestrator, metrics({ cachedTokens: 800, cacheWriteTokens: 200 })),
			withSessionId(sessionId, llmEvents.create('auxiliary_inference_completed', {
				agentId: orchestrator,
				metrics: metrics({ cachedTokens: 50, cacheWriteTokens: 10 }),
			})),
			// Providers that report no cache usage must not break the totals.
			inference(orchestrator, metrics()),
		])
		expect(stats.cacheReadTokens).toBe(850)
		expect(stats.cacheWriteTokens).toBe(210)
		expect(stats.llmCalls).toBe(3)
	})

	it('breaks LLM usage down by agent definition name', () => {
		const stats = reduce([
			spawn(orchestrator, 'orchestrator'),
			spawn(worker, 'coder'),
			inference(orchestrator, metrics({ promptTokens: 100, completionTokens: 20, cost: 0.5 })),
			inference(worker, metrics({ promptTokens: 300, completionTokens: 40, cost: 1.25 })),
			inference(worker, metrics({ promptTokens: 200, completionTokens: 10, cost: 0.25 })),
			withSessionId(sessionId, llmEvents.create('auxiliary_inference_completed', {
				agentId: worker,
				metrics: metrics({ promptTokens: 10, completionTokens: 1, cost: 0.05 }),
			})),
		])
		expect(stats.byAgent).toEqual({
			orchestrator: { llmCalls: 1, promptTokens: 100, completionTokens: 20, totalCost: 0.5 },
			coder: { llmCalls: 3, promptTokens: 510, completionTokens: 51, totalCost: 1.55 },
		})
		expect(stats.totalCost).toBeCloseTo(2.05, 10)
	})

	it('keeps existing counters working', () => {
		const stats = reduce([
			spawn(orchestrator, 'orchestrator'),
			inference(orchestrator, metrics()),
			withSessionId(sessionId, llmEvents.create('inference_failed', { agentId: orchestrator, error: 'boom' })),
			withSessionId(sessionId, toolEvents.create('tool_started', {
				agentId: orchestrator,
				toolCallId: ToolCallId('tc-1'),
				toolName: 'read_file',
				input: {},
			})),
			withSessionId(sessionId, toolEvents.create('tool_failed', {
				agentId: orchestrator,
				toolCallId: ToolCallId('tc-1'),
				error: 'ENOENT',
			})),
		])
		expect(stats.agentCount).toBe(1)
		expect(stats.llmCalls).toBe(1)
		expect(stats.llmErrors).toBe(1)
		expect(stats.toolCalls).toBe(1)
		expect(stats.toolErrors).toBe(1)
		expect(stats.totalTokens).toBe(120)
		expect(stats.promptTokens).toBe(100)
		expect(stats.completionTokens).toBe(20)
		expect(stats.byProvider.anthropic).toEqual({
			llmCalls: 1,
			totalTokens: 120,
			promptTokens: 100,
			completionTokens: 20,
			totalCost: 0.5,
		})
	})
})
