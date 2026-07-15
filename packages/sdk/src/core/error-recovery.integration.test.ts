import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import type { AgentStatus } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { llmEvents } from '~/core/llm/state.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createTool } from '~/core/tools/definition.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { toolEvents } from '~/core/tools/state.js'
import { Ok } from '~/lib/utils/result.js'
import type { TestSession } from '~/testing/index.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

/** Poll until the entry agent reaches the given status (or time out). */
async function waitForAgentStatus(session: TestSession, status: AgentStatus, timeoutMs = 5000): Promise<void> {
	const agentId = session.getEntryAgentId()!
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (session.state.agents.get(agentId)?.status === status) return
		await new Promise((r) => setTimeout(r, 10))
	}
	throw new Error(`Agent did not reach status '${status}' within ${timeoutMs}ms`)
}

/** Count conversation-history messages whose content mentions the given text. */
function countHistoryMentions(session: TestSession, text: string): number {
	const agentId = session.getEntryAgentId()!
	const history = session.state.agents.get(agentId)!.conversationHistory
	return history.filter((m) => JSON.stringify(m.content).includes(text)).length
}

describe('core: error recovery', () => {
	// =========================================================================
	// Retryable LLM errors — outer error-resume backoff
	// =========================================================================

	describe('retryable LLM error exhaustion', () => {
		it('backs off between error-resume cycles, notifies parent hook once, and recovers without losing the message', async () => {
			// Fail 10 LLM calls (2 inference cycles × 5 withLLMRetry attempts), then succeed.
			let llmCalls = 0
			const llmProvider = new MockLLMProvider(() => {
				llmCalls++
				if (llmCalls <= 10) {
					throw { type: 'server_error', message: 'boom', retryAfterMs: 1 }
				}
				return {
					content: 'Recovered',
					toolCalls: [],
					finishReason: 'stop' as const,
					metrics: MockLLMProvider.defaultMetrics(),
				}
			})

			let onErrorCalls = 0
			const errorTracker = definePlugin('error-tracker')
				.hook('onError', async () => {
					onErrorCalls++
					return null
				})
				.build()

			const preset = createTestPreset()
			preset.orchestrator.errorResumeBackoff = { baseDelayMs: 50, maxDelayMs: 100 }

			const harness = new TestHarness({
				presets: [preset],
				llmProvider,
				systemPlugins: [errorTracker],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Trigger outage', { timeoutMs: 10_000 })

			// The message survived the outage: delivered to the LLM exactly once, answered.
			expect(countHistoryMentions(session, 'Trigger outage')).toBe(1)
			expect(countHistoryMentions(session, 'Recovered')).toBe(1)
			expect(llmCalls).toBe(11)

			// Two failed cycles, each resumed exactly once — no unbounded spin.
			const failed = await session.getEventsByType(llmEvents, 'inference_failed')
			expect(failed).toHaveLength(2)
			const resumed = await session.getEventsByType(agentEvents, 'agent_resumed')
			expect(resumed).toHaveLength(2)

			// The resume waited for the backoff: 50ms after the 1st failure, 100ms after the 2nd.
			expect(resumed[0].timestamp - failed[0].timestamp).toBeGreaterThanOrEqual(45)
			expect(resumed[1].timestamp - failed[1].timestamp).toBeGreaterThanOrEqual(90)

			// onError hooks fired once per episode, not once per cycle.
			expect(onErrorCalls).toBe(1)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// afterInference retry — token consumption deferred to commit
	// =========================================================================

	describe('afterInference retry', () => {
		it('pure-message turn: retry re-delivers the message instead of stranding the agent', async () => {
			const retryOnV1 = definePlugin('retry-on-v1')
				.hook('afterInference', async (ctx) => {
					if (ctx.response.content === 'v1') return { action: 'retry' as const }
					return null
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{ content: 'v1' },
					{ content: 'v2' },
				]),
				systemPlugins: [retryOnV1],
			})

			const session = await harness.createSession('test')
			// Before the fix this stranded the agent in 'inferring' (mapped to idle) forever.
			await session.sendAndWaitForIdle('Retry me')

			expect(harness.llmProvider.getCallCount()).toBe(2)
			const retried = await session.getEventsByType(llmEvents, 'inference_retried')
			expect(retried).toHaveLength(1)

			// The user message was staged exactly once and the retried response won.
			expect(countHistoryMentions(session, 'Retry me')).toBe(1)
			expect(countHistoryMentions(session, 'v2')).toBe(1)
			expect(countHistoryMentions(session, 'v1')).toBe(0)

			await harness.shutdown()
		})

		it('tool-result turn: retry does not duplicate tool results in history or in the LLM request', async () => {
			const retryOnV1 = definePlugin('retry-on-v1')
				.hook('afterInference', async (ctx) => {
					if (ctx.response.content === 'v1') return { action: 'retry' as const }
					return null
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{ toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }] },
					{ content: 'v1' },
					{ content: 'v2' },
				]),
				systemPlugins: [retryOnV1],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Run a tool')

			expect(harness.llmProvider.getCallCount()).toBe(3)

			// The retried request carries the tool result exactly once.
			const lastRequest = harness.llmProvider.getLastRequest()!
			expect(lastRequest.messages.filter((m) => m.role === 'tool')).toHaveLength(1)

			// And so does the committed history — duplicates would 400 on the next turn.
			const agentId = session.getEntryAgentId()!
			const history = session.state.agents.get(agentId)!.conversationHistory
			expect(history.filter((m) => m.role === 'tool')).toHaveLength(1)
			expect(countHistoryMentions(session, 'Run a tool')).toBe(1)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Pause from tool hooks — turn stops, nothing re-executes
	// =========================================================================

	describe('pause from tool hooks', () => {
		const makeCountingTool = (name: string, counter: { count: number }) =>
			createTool({
				name,
				description: `Counting tool ${name}`,
				input: z.unknown(),
				execute: async () => {
					counter.count++
					return Ok(`${name} done`)
				},
			})

		it('beforeToolCall pause stops the multi-tool turn; resume runs every tool exactly once', async () => {
			const aRuns = { count: 0 }
			const bRuns = { count: 0 }

			let pausedOnce = false
			const pauser = definePlugin('pauser')
				.hook('beforeToolCall', async (ctx) => {
					if (ctx.toolCall.name === 'tool_a' && !pausedOnce) {
						pausedOnce = true
						return { action: 'pause' as const, reason: 'gate' }
					}
					return null
				})
				.build()

			const preset = createTestPreset()
			preset.orchestrator.tools = [makeCountingTool('tool_a', aRuns), makeCountingTool('tool_b', bRuns)]

			const harness = new TestHarness({
				presets: [preset],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [
							{ id: ToolCallId('ta'), name: 'tool_a', input: {} },
							{ id: ToolCallId('tb'), name: 'tool_b', input: {} },
						],
					},
					{ content: 'Done', toolCalls: [] },
				]),
				systemPlugins: [pauser],
			})

			const session = await harness.createSession('test')
			await session.sendMessage('Run tools')
			await waitForAgentStatus(session, 'paused')

			// Neither tool ran: tool_a was gated pre-start, tool_b must not run while paused.
			const agentId = session.getEntryAgentId()!
			expect(aRuns.count).toBe(0)
			expect(bRuns.count).toBe(0)
			expect(session.state.agents.get(agentId)!.pendingToolCalls).toHaveLength(2)

			await session.resumeAgent(agentId)
			await session.waitForIdle()

			// After resume the whole turn ran exactly once per tool.
			expect(aRuns.count).toBe(1)
			expect(bRuns.count).toBe(1)
			const completed = await session.getEventsByType(toolEvents, 'tool_completed')
			expect(completed).toHaveLength(2)

			await harness.shutdown()
		})

		it('afterToolCall pause commits the executed tool result and does not re-run it on resume', async () => {
			const aRuns = { count: 0 }
			const bRuns = { count: 0 }

			let pausedOnce = false
			const pauser = definePlugin('pauser')
				.hook('afterToolCall', async (ctx) => {
					if (ctx.toolCall.name === 'tool_a' && !pausedOnce) {
						pausedOnce = true
						return { action: 'pause' as const, reason: 'checkpoint' }
					}
					return null
				})
				.build()

			const preset = createTestPreset()
			preset.orchestrator.tools = [makeCountingTool('tool_a', aRuns), makeCountingTool('tool_b', bRuns)]

			const harness = new TestHarness({
				presets: [preset],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [
							{ id: ToolCallId('ta'), name: 'tool_a', input: {} },
							{ id: ToolCallId('tb'), name: 'tool_b', input: {} },
						],
					},
					{ content: 'Done', toolCalls: [] },
				]),
				systemPlugins: [pauser],
			})

			const session = await harness.createSession('test')
			await session.sendMessage('Run tools')
			await waitForAgentStatus(session, 'paused')

			// tool_a ran and its result committed (paired tool_use); tool_b is still pending.
			const agentId = session.getEntryAgentId()!
			const agentState = session.state.agents.get(agentId)!
			expect(aRuns.count).toBe(1)
			expect(bRuns.count).toBe(0)
			expect(agentState.pendingToolCalls.map((tc) => tc.name)).toEqual(['tool_b'])
			expect(agentState.pendingToolResults.map((r) => r.toolName)).toEqual(['tool_a'])

			await session.resumeAgent(agentId)
			await session.waitForIdle()

			// tool_a's side effects were NOT repeated after resume.
			expect(aRuns.count).toBe(1)
			expect(bRuns.count).toBe(1)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Manual pause during an in-flight inference
	// =========================================================================

	describe('manual pause during inference', () => {
		it('pause landing mid-inference is preserved after the turn commits', async () => {
			let firstCall = true
			const llmProvider = new MockLLMProvider(async () => {
				if (firstCall) {
					firstCall = false
					await new Promise((r) => setTimeout(r, 150))
					return { content: 'Late reply', toolCalls: [], finishReason: 'stop' as const, metrics: MockLLMProvider.defaultMetrics() }
				}
				return { content: 'After resume', toolCalls: [], finishReason: 'stop' as const, metrics: MockLLMProvider.defaultMetrics() }
			})

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider,
			})

			const session = await harness.createSession('test')
			await session.sendMessage('Slow question')
			await waitForAgentStatus(session, 'inferring')

			const agentId = session.getEntryAgentId()!
			await session.pauseAgent(agentId, 'user hit pause')

			// Let the in-flight LLM call resolve and the turn commit.
			await new Promise((r) => setTimeout(r, 300))

			// The pause survived the inference_completed reducer — previously it was
			// silently clobbered and the agent kept running.
			const agentState = session.state.agents.get(agentId)!
			expect(agentState.status).toBe('paused')
			// The turn itself committed (the response is in history, message consumed).
			expect(countHistoryMentions(session, 'Late reply')).toBe(1)
			expect(countHistoryMentions(session, 'Slow question')).toBe(1)

			await session.resumeAgent(agentId)
			await session.waitForIdle()
			expect(session.state.agents.get(agentId)!.status).toBe('pending')

			await harness.shutdown()
		})
	})
})
