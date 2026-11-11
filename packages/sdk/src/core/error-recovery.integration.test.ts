import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import type { AgentStatus } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { llmEvents } from '~/core/llm/state.js'
import { sessionEvents } from '~/core/sessions/state.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import { agentStatusPlugin, agentStoppedNotificationSchema } from '~/plugins/agent-status/plugin.js'
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

		it('beforeToolCall replace keeps the tool_use identity and runs the call exactly once', async () => {
			const aRuns = { count: 0 }
			const bRuns = { count: 0 }

			const swapper = definePlugin('swapper')
				.hook('beforeToolCall', async (ctx) => {
					if (ctx.toolCall.name !== 'tool_a') return null
					return { action: 'replace' as const, toolCall: { id: 'rewritten', name: 'tool_b', input: {} } }
				})
				.build()

			const preset = createTestPreset()
			preset.orchestrator.tools = [makeCountingTool('tool_a', aRuns), makeCountingTool('tool_b', bRuns)]

			const harness = new TestHarness({
				presets: [preset],
				llmProvider: MockLLMProvider.withSequence([
					{ toolCalls: [{ id: ToolCallId('ta'), name: 'tool_a', input: {} }] },
					{ content: 'Done', toolCalls: [] },
				]),
				systemPlugins: [swapper],
			})

			const session = await harness.createSession('test')
			await session.sendMessage('Run tools')
			await session.waitForIdle()

			// The replacement body ran once; a hook cannot mint a new tool_use id, so the
			// pending call clears and the turn ends instead of re-entering on the same head.
			expect(aRuns.count).toBe(0)
			expect(bRuns.count).toBe(1)
			const completed = await session.getEventsByType(toolEvents, 'tool_completed')
			expect(completed).toHaveLength(1)
			expect(completed[0]!.toolCallId).toBe(ToolCallId('ta'))
			const agentId = session.getEntryAgentId()!
			expect(session.state.agents.get(agentId)!.pendingToolCalls).toHaveLength(0)

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

describe('core: an agent the provider keeps rejecting', () => {
	const CHILD_SYSTEM = 'Child agent: inspect the page.'
	const REJECTED = 'Provider returned error'
	const lookTool = createTool({
		name: 'look',
		description: 'Look at the page',
		input: z.object({}),
		execute: async () => Ok('a large screenshot'),
	})
	const preset = createTestPreset({ agents: [{ name: 'child', system: CHILD_SYSTEM, tools: [lookTool], agents: [] }] })

	const waitUntil = async (predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
		const deadline = Date.now() + timeoutMs
		while (!(await predicate())) {
			if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
			await Bun.sleep(5)
		}
	}

	/**
	 * A child whose first turn calls a tool and whose every turn carrying the tool result is rejected, as an oversized
	 * image would be. It fails once per load and is paused on the third; returns the harness of that third load.
	 */
	async function childRejectedAcrossRestarts() {
		const calls = { child: 0 }
		// What the provider does with the child's later turns; a test can switch it after the pause.
		const provider: { child: 'reject' | 'outage' | 'answer' } = { child: 'reject' }
		const llmProvider = new MockLLMProvider((request) => {
			if (!request.systemPrompt.includes(CHILD_SYSTEM)) {
				return { content: 'Noted', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			}
			calls.child++
			if (calls.child === 1) {
				return { content: null, toolCalls: [{ id: ToolCallId('look-1'), name: 'look', input: {} }], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			}
			if (provider.child === 'outage') throw { type: 'server_error', message: 'upstream 502', retryAfterMs: 1 }
			if (provider.child === 'answer') return { content: 'Inspected', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			throw { type: 'invalid_request', message: REJECTED }
		})

		const first = new TestHarness({ presets: [preset], llmProvider })
		const eventStore = first.eventStore
		const session = await first.createSession('test')
		const entryId = session.getEntryAgentId()!
		const live = await first.sessionManager.getSession(session.sessionId)
		if (!live.ok) throw new Error(live.error.message)
		const spawned = await live.value.spawnAgentManually('child', entryId, 'Inspect the page')
		if (!spawned.ok) throw new Error(spawned.error.message)
		const childId = spawned.value

		const childFailures = async () => (await session.getEventsByType(llmEvents, 'inference_failed')).filter((e) => e.agentId === childId).length
		const childNotices = async () =>
			(await session.getEventsByType(mailboxEvents, 'mailbox_message')).filter((e) => e.message.from === childId).map((e) => e.message.content)
		const childPauses = async () => (await session.getEventsByType(agentEvents, 'agent_paused')).filter((e) => e.agentId === childId)
		await waitUntil(async () => (await childNotices()).length === 1)
		await first.shutdown()

		let pausing = first
		for (const expectedFailures of [2, 3]) {
			pausing = new TestHarness({ presets: [preset], llmProvider, eventStore, systemPlugins: [agentStatusPlugin] })
			await pausing.sessionManager.loadAllSessions()
			await waitUntil(async () => (await childFailures()) === expectedFailures)
			await waitUntil(async () => (await childNotices()).length === expectedFailures)
			await pausing.shutdown()
		}
		return { calls, provider, llmProvider, eventStore, session, childId, childFailures, childNotices, childPauses, pausing }
	}

	it('pauses after three rejections across restarts, tells its parent once, and is not reset again', async () => {
		const { calls, llmProvider, eventStore, session, childId, childNotices, childPauses, pausing } = await childRejectedAcrossRestarts()

		const afterPause = new TestHarness({ presets: [preset], llmProvider, eventStore })
		await afterPause.sessionManager.loadAllSessions()
		await Bun.sleep(100)
		const reloaded = await afterPause.sessionManager.getSession(session.sessionId)
		if (!reloaded.ok) throw new Error(reloaded.error.message)
		expect(reloaded.value.state.agents.get(childId)?.status).toBe('paused')
		await afterPause.shutdown()

		expect(calls.child).toBe(4)
		const pauses = await childPauses()
		expect(pauses).toHaveLength(1)
		expect(pauses[0].reason).toBe('limit')
		const restarts = await session.getEventsByType(sessionEvents, 'session_restarted')
		const resetAfterPause = restarts.filter((e) => e.timestamp >= pauses[0].timestamp).flatMap((e) => e.resetAgentIds)
		expect(resetAfterPause).not.toContain(childId)

		const fromChild = await childNotices()
		expect(fromChild.filter((content) => content.startsWith('Agent encountered an error:'))).toHaveLength(2)
		const pausedNotices = fromChild.filter((content) => content.startsWith('<child-paused'))
		expect(pausedNotices).toHaveLength(1)
		expect(pausedNotices[0]).toContain(REJECTED)

		// The pausing failure skips onError, so its alert is a pause, not an error.
		const stopped = pausing.notifications.getAll()
			.filter((n) => n.pluginName === 'agent-status' && n.type === 'agentStopped')
			.map((n) => agentStoppedNotificationSchema.parse(n.payload))
			.filter((n) => n.agentId === childId)
		expect(stopped.map((n) => [n.kind, n.reason])).toEqual([['paused', 'limit']])
	})

	it('a resumed agent retries the turn once, and pauses again when it is rejected again', async () => {
		const { calls, llmProvider, eventStore, session, childId, childNotices, childPauses } = await childRejectedAcrossRestarts()

		const resuming = new TestHarness({ presets: [preset], llmProvider, eventStore })
		await resuming.sessionManager.loadAllSessions()
		const live = await resuming.sessionManager.getSession(session.sessionId)
		if (!live.ok) throw new Error(live.error.message)
		const resumed = await live.value.resumeAgent(childId)
		if (!resumed.ok) throw new Error(resumed.error.message)
		await waitUntil(async () => (await childPauses()).length === 2)
		await waitUntil(async () => (await childNotices()).length === 4)
		await resuming.shutdown()

		expect(calls.child).toBe(5)
		expect((await childNotices()).filter((content) => content.startsWith('<child-paused'))).toHaveLength(2)
	})

	it('a resumed agent that hits an outage is retried after it, not paused again', async () => {
		const { calls, provider, llmProvider, eventStore, session, childId, childFailures, childPauses } = await childRejectedAcrossRestarts()

		provider.child = 'outage'
		const resuming = new TestHarness({ presets: [preset], llmProvider, eventStore })
		await resuming.sessionManager.loadAllSessions()
		const live = await resuming.sessionManager.getSession(session.sessionId)
		if (!live.ok) throw new Error(live.error.message)
		const resumed = await live.value.resumeAgent(childId)
		if (!resumed.ok) throw new Error(resumed.error.message)
		// The LLM retry gives up after five attempts and the turn fails as retryable.
		await waitUntil(async () => (await childFailures()) === 4)
		await Bun.sleep(50)
		expect(live.value.state.agents.get(childId)?.status).toBe('errored')
		await resuming.shutdown()

		// The provider is back; the next restart resets the errored agent and the kept turn goes through.
		provider.child = 'answer'
		const recovered = new TestHarness({ presets: [preset], llmProvider, eventStore })
		await recovered.sessionManager.loadAllSessions()
		const reloaded = await recovered.sessionManager.getSession(session.sessionId)
		if (!reloaded.ok) throw new Error(reloaded.error.message)
		const reloadedSession = reloaded.value
		await waitUntil(async () => reloadedSession.state.agents.get(childId)?.consecutiveRejectedTurns === undefined)
		await recovered.shutdown()

		expect(await childPauses()).toHaveLength(1)
		expect(calls.child).toBe(4 + 5 + 1)
		const failures = (await session.getEventsByType(llmEvents, 'inference_failed')).filter((e) => e.agentId === childId)
		expect(failures.map((e) => e.errorType)).toEqual(['invalid_request', 'invalid_request', 'invalid_request', 'server_error'])
	})

	it('a root agent whose messages are rejected answers the next valid message', async () => {
		let calls = 0
		const llmProvider = new MockLLMProvider((request) => {
			calls++
			if (JSON.stringify(request.messages).includes('oversized image')) throw { type: 'invalid_request', message: REJECTED }
			return { content: 'Answered', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
		})
		const rootPreset = createTestPreset()
		rootPreset.orchestrator.errorResumeBackoff = { baseDelayMs: 1, maxDelayMs: 1 }
		const harness = new TestHarness({ presets: [rootPreset], llmProvider })
		const session = await harness.createSession('test')
		const entryId = session.getEntryAgentId()!
		const failures = async () => (await session.getEventsByType(llmEvents, 'inference_failed')).length

		for (const expected of [1, 2, 3]) {
			await session.sendMessage('Here is an oversized image')
			await waitUntil(async () => (await failures()) === expected)
		}
		await session.sendAndWaitForIdle('Just a question')

		expect(calls).toBe(4)
		expect(session.state.agents.get(entryId)?.status).not.toBe('paused')
		expect(countHistoryMentions(session, 'Answered')).toBe(1)
		expect(await session.getEventsByType(agentEvents, 'agent_paused')).toHaveLength(0)

		await harness.shutdown()
	})
})
