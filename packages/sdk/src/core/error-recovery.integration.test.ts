import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import type { AgentStatus } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { InferenceRequest } from '~/core/llm/provider.js'
import { ModelId } from '~/core/llm/schema.js'
import { llmEvents } from '~/core/llm/state.js'
import { sessionEvents } from '~/core/sessions/state.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import { uploadEvents } from '~/plugins/uploads/state.js'
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
	const CHILD_MODEL = ModelId('anthropic/claude-haiku-5.5')
	// What OpenRouter answers when the upstream provider refuses the request.
	const REJECTION_BODY = JSON.stringify({ message: REJECTED, code: 400, metadata: { raw: '{"type":"error","error":{"type":"invalid_request_error","message":"image exceeds 5 MB maximum"}}' } })
	const SCREENSHOT_URL = `data:image/png;base64,${Buffer.alloc(1_000, 9).toString('base64')}`
	const lookTool = createTool({
		name: 'look',
		description: 'Look at the page',
		input: z.object({}),
		execute: async () => Ok([{ type: 'image_url' as const, imageUrl: { url: SCREENSHOT_URL } }]),
	})
	const sendsImageToolResult = (request: InferenceRequest): boolean =>
		request.messages.some((message) => message.role === 'tool' && typeof message.content !== 'string' && message.content.some((item) => item.type === 'image_url'))
	const preset = createTestPreset({ agents: [{ name: 'child', system: CHILD_SYSTEM, model: CHILD_MODEL, tools: [lookTool], agents: [] }] })

	const waitUntil = async (predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
		const deadline = Date.now() + timeoutMs
		while (!(await predicate())) {
			if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
			await Bun.sleep(5)
		}
	}

	/**
	 * A child whose first turn calls a tool and whose every turn carrying its image result is rejected, as an oversized
	 * image would be. It fails once per load and is paused on the third; returns the harness of that third load.
	 */
	async function childRejectedAcrossRestarts() {
		const calls = { child: 0 }
		const sent: InferenceRequest[] = []
		// What the provider does with the child's later turns; a test can switch it after the pause.
		const provider: { child: 'rejectImages' | 'rejectAll' | 'outage' | 'answer' } = { child: 'rejectImages' }
		const llmProvider = new MockLLMProvider((request) => {
			if (!request.systemPrompt.includes(CHILD_SYSTEM)) {
				return { content: 'Noted', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			}
			calls.child++
			sent.push(request)
			if (calls.child === 1) {
				return { content: null, toolCalls: [{ id: ToolCallId('look-1'), name: 'look', input: {} }], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			}
			if (provider.child === 'outage') throw { type: 'server_error', message: 'upstream 502', retryAfterMs: 1 }
			if (provider.child === 'answer' || (provider.child === 'rejectImages' && !sendsImageToolResult(request))) {
				return { content: 'Inspected', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			}
			throw { type: 'invalid_request', message: REJECTED, statusCode: 400, providerError: { statusCode: 400, body: REJECTION_BODY } }
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
		return { calls, sent, provider, llmProvider, eventStore, session, childId, childFailures, childNotices, childPauses, pausing }
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
		expect(stopped[0].inferenceFailure).toEqual({ errorType: 'invalid_request', model: CHILD_MODEL, providerError: { statusCode: 400, body: REJECTION_BODY } })
	})

	it('a resumed agent sends the turn without the rejected image and goes on', async () => {
		const { calls, sent, llmProvider, eventStore, session, childId, childPauses } = await childRejectedAcrossRestarts()

		const resuming = new TestHarness({ presets: [preset], llmProvider, eventStore })
		await resuming.sessionManager.loadAllSessions()
		const live = await resuming.sessionManager.getSession(session.sessionId)
		if (!live.ok) throw new Error(live.error.message)
		const resumed = await live.value.resumeAgent(childId)
		if (!resumed.ok) throw new Error(resumed.error.message)
		await waitUntil(async () => live.value.state.agents.get(childId)?.consecutiveRejectedTurns === undefined)
		await resuming.shutdown()

		expect(calls.child).toBe(5)
		expect(await childPauses()).toHaveLength(1)
		const toolResults = sent[4].messages.filter((message) => message.role === 'tool')
		expect(toolResults.map((message) => message.content)).toEqual(['content omitted: the provider rejected it: invalid_request'])
		const history = live.value.state.agents.get(childId)?.conversationHistory ?? []
		expect(history.at(-1)).toMatchObject({ role: 'assistant', content: 'Inspected' })
	})

	it('a resumed agent whose turn is rejected without the image too pauses again', async () => {
		const { calls, provider, llmProvider, eventStore, session, childId, childNotices, childPauses } = await childRejectedAcrossRestarts()

		provider.child = 'rejectAll'
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
		expect(live.value.state.agents.get(childId)?.pauseInferenceFailure?.providerError?.statusCode).toBe(400)
		const resumed = await live.value.resumeAgent(childId)
		if (!resumed.ok) throw new Error(resumed.error.message)
		// The LLM retry gives up after five attempts and the turn fails as retryable.
		await waitUntil(async () => (await childFailures()) === 4)
		await Bun.sleep(50)
		expect(live.value.state.agents.get(childId)?.status).toBe('errored')
		// The rejection that caused the pause is not carried past the resume.
		expect(live.value.state.agents.get(childId)?.pauseInferenceFailure).toBeUndefined()
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

	/**
	 * An entry agent whose first turn calls a tool and whose turns carrying its image result are rejected. The first
	 * failure follows the tool; the user's next message is kept through its rejected turn and retried with it, and the
	 * third failure pauses the agent with that message still queued.
	 */
	async function entryAgentPausedOnRejectedTurns() {
		const ENTRY_SYSTEM = 'Entry agent: inspect the page.'
		const sent: InferenceRequest[] = []
		const provider: { entry: 'rejectImages' | 'rejectAll' } = { entry: 'rejectImages' }
		const llmProvider = new MockLLMProvider((request) => {
			sent.push(request)
			if (sent.length === 1) {
				return { content: null, toolCalls: [{ id: ToolCallId('look-1'), name: 'look', input: {} }], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			}
			if (provider.entry === 'rejectImages' && !sendsImageToolResult(request)) {
				return { content: 'Inspected', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			}
			throw { type: 'invalid_request', message: REJECTED, statusCode: 400, providerError: { statusCode: 400, body: REJECTION_BODY } }
		})
		const base = createTestPreset({ orchestratorSystem: ENTRY_SYSTEM })
		const entryPreset = { ...base, orchestrator: { ...base.orchestrator, tools: [lookTool], errorResumeBackoff: { baseDelayMs: 1, maxDelayMs: 1 } } }
		const harness = new TestHarness({ presets: [entryPreset], llmProvider })
		const session = await harness.createSession('test')
		const entryId = session.getEntryAgentId()!
		const failures = async () => (await session.getEventsByType(llmEvents, 'inference_failed')).filter((e) => e.agentId === entryId).length
		const pauses = async () => (await session.getEventsByType(agentEvents, 'agent_paused')).filter((e) => e.agentId === entryId)
		const entryState = () => session.state.agents.get(entryId)

		await session.sendMessage('Inspect the page')
		await waitUntil(async () => (await failures()) === 1)
		await session.sendMessage('Try again')
		await waitUntil(async () => (await pauses()).length === 1)
		expect(await failures()).toBe(3)
		expect(sent).toHaveLength(4)
		// The rejected turns carried the tool result, so the user's message went out with both of them and stays queued.
		expect(sentUserText(sent[2])).toContain('Try again')
		expect(sentUserText(sent[3])).toContain('Try again')
		expect(countHistoryMentions(session, 'Try again')).toBe(0)
		expect((await pauses())[0]).toMatchObject({ reason: 'limit' })
		expect(entryState()?.pauseResumesOnInput).toBe(true)
		expect(entryState()?.consecutiveRejectedTurns).toBe(3)
		return { harness, session, sent, provider, failures, pauses, entryState }
	}

	const sentUserText = (request: InferenceRequest): string => JSON.stringify(request.messages.filter((message) => message.role === 'user'))

	it('a paused entry agent resumes on its user\'s next message and answers it with the message it kept', async () => {
		const { harness, session, sent, pauses, entryState } = await entryAgentPausedOnRejectedTurns()

		await session.sendMessage('Please go on')
		await waitUntil(async () => entryState()?.conversationHistory.at(-1)?.content === 'Inspected')

		expect(sent).toHaveLength(5)
		expect(sentUserText(sent[4])).toContain('Try again')
		expect(sentUserText(sent[4])).toContain('Please go on')
		const toolResults = sent[4].messages.filter((message) => message.role === 'tool')
		expect(toolResults.map((message) => message.content)).toEqual(['content omitted: the provider rejected it: invalid_request'])
		const state = entryState()
		expect(state?.status).not.toBe('paused')
		expect(state?.consecutiveRejectedTurns).toBeUndefined()
		expect(state?.conversationHistory.at(-1)).toMatchObject({ role: 'assistant', content: 'Inspected' })
		expect(countHistoryMentions(session, 'Try again')).toBe(1)
		expect(countHistoryMentions(session, 'Please go on')).toBe(1)
		expect(await pauses()).toHaveLength(1)

		await harness.shutdown()
	})

	it('a resumed entry agent whose turn is rejected without the image drops the text with it, one attempt per message, and pauses again', async () => {
		const { harness, session, sent, provider, failures, pauses, entryState } = await entryAgentPausedOnRejectedTurns()

		provider.entry = 'rejectAll'
		await session.sendMessage('Please go on')
		await waitUntil(async () => (await failures()) === 4)
		await Bun.sleep(50)
		// The resume replaced the image with the omission note, so the user's text is the only suspect left.
		expect(sentUserText(sent[4])).toContain('Try again')
		expect(sentUserText(sent[4])).toContain('Please go on')
		expect(sent).toHaveLength(5)
		expect(entryState()?.status).toBe('errored')
		expect(entryState()?.consecutiveRejectedTurns).toBe(1)

		for (const expected of [5, 6]) {
			await session.sendMessage(`Go on ${expected}`)
			await waitUntil(async () => (await failures()) === expected)
		}
		await waitUntil(async () => (await pauses()).length === 2)
		await Bun.sleep(50)

		expect(sent).toHaveLength(7)
		expect(sentUserText(sent[6])).not.toContain('Please go on')
		expect(entryState()?.status).toBe('paused')
		expect((await pauses())[1]).toMatchObject({ reason: 'limit' })

		await harness.shutdown()
	})

	it('an operator resume of a paused entry agent keeps its rejected-turn streak', async () => {
		const { harness, session, sent, provider, pauses, entryState } = await entryAgentPausedOnRejectedTurns()

		provider.entry = 'rejectAll'
		const live = await harness.sessionManager.getSession(session.sessionId)
		if (!live.ok) throw new Error(live.error.message)
		const resumed = await live.value.resumeAgent(session.getEntryAgentId()!)
		if (!resumed.ok) throw new Error(resumed.error.message)
		await waitUntil(async () => (await pauses()).length === 2)

		expect(sent).toHaveLength(5)
		expect(entryState()?.consecutiveRejectedTurns).toBe(4)

		await harness.shutdown()
	})

	/**
	 * An entry agent whose provider rejects any turn that carries the content of an upload named `refused.txt` or the
	 * text 'A huge paste'. With `unauthorizedOnce`, the first request fails with a 401 instead, which rejects no content.
	 */
	async function entryAgentWithRefusedUpload(options: { unauthorizedOnce?: boolean } = {}) {
		const REFUSED = '[File uploaded: refused.txt]'
		const sent: InferenceRequest[] = []
		const llmProvider = new MockLLMProvider((request) => {
			sent.push(request)
			if (options.unauthorizedOnce && sent.length === 1) {
				throw { type: 'invalid_request', message: 'Unauthorized', statusCode: 401, providerError: { statusCode: 401, body: '{"message":"Unauthorized"}' } }
			}
			if (sentUserText(request).includes(REFUSED) || sentUserText(request).includes('A huge paste')) {
				throw { type: 'invalid_request', message: REJECTED, statusCode: 400, providerError: { statusCode: 400, body: REJECTION_BODY } }
			}
			return { content: 'Answered', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
		})
		const base = createTestPreset()
		const rootPreset = { ...base, orchestrator: { ...base.orchestrator, errorResumeBackoff: { baseDelayMs: 1, maxDelayMs: 1 } } }
		const harness = new TestHarness({ presets: [rootPreset], llmProvider })
		const session = await harness.createSession('test')
		const entryId = session.getEntryAgentId()!
		const sessionId = String(session.sessionId)
		const uploadPage = async (filename: string) => {
			const fileContent = Buffer.from('A page')
			const uploaded = await session.callPluginMethod('uploads.upload', { sessionId, filename, mimeType: 'text/plain', size: fileContent.length, fileBuffer: fileContent })
			if (!uploaded.ok) throw new Error(uploaded.error.message)
			return z.object({ uploadId: z.string() }).parse(uploaded.value).uploadId
		}
		/** The uploads a client offers as attachments for the next message. */
		const attachableUploads = async () => {
			const listed = await session.callPluginMethod('uploads.listPending', { sessionId })
			if (!listed.ok) throw new Error(listed.error.message)
			return z.object({ uploads: z.array(z.object({ uploadId: z.string() })) }).parse(listed.value).uploads.map((upload) => upload.uploadId)
		}
		const failures = async () => (await session.getEventsByType(llmEvents, 'inference_failed')).length
		const answered = () => waitUntil(async () => session.state.agents.get(entryId)?.conversationHistory.at(-1)?.content === 'Answered')
		return { REFUSED, sent, harness, session, sessionId, uploadPage, attachableUploads, failures, answered }
	}

	it('a rejected turn that carried an attachment keeps the user\'s text and retries it with a note that the attachment was omitted', async () => {
		const { REFUSED, sent, harness, session, sessionId, uploadPage, attachableUploads, answered } = await entryAgentWithRefusedUpload()
		const uploadId = await uploadPage('refused.txt')

		await session.sendMessage('Put this on the about page')
		await answered()

		expect(sent).toHaveLength(2)
		expect(sentUserText(sent[0])).toContain(REFUSED)
		expect(sentUserText(sent[0])).toContain('Put this on the about page')
		expect(sentUserText(sent[1])).not.toContain(REFUSED)
		expect(sentUserText(sent[1])).toContain('Put this on the about page')
		expect(sentUserText(sent[1])).toContain(`<attachment uploadId=\\"${uploadId}\\" filename=\\"refused.txt\\" type=\\"text/plain\\">\\ncontent omitted: the provider rejected it: invalid_request`)
		expect(countHistoryMentions(session, 'Put this on the about page')).toBe(1)
		expect(await session.getEventsByType(agentEvents, 'agent_paused')).toHaveLength(0)
		await session.sendAndWaitForIdle('Anything else?')
		expect(sent).toHaveLength(3)
		expect(sentUserText(sent[2]).split('content omitted')).toHaveLength(2)
		expect(countHistoryMentions(session, 'content omitted')).toBe(1)
		// Left out, not consumed: no longer offered for the next message, but still the user's to delete.
		expect(await session.getEventsByType(uploadEvents, 'attachments_consumed')).toHaveLength(0)
		expect(await attachableUploads()).toEqual([])
		const deleted = await session.callPluginMethod('uploads.delete', { sessionId, uploadId })
		expect(deleted.ok).toBe(true)

		await harness.shutdown()
	})

	it('a retried turn rejected with only the omission note drops the user\'s text and keeps the note for the next message', async () => {
		const { REFUSED, sent, harness, session, uploadPage, failures, answered } = await entryAgentWithRefusedUpload()
		await uploadPage('refused.txt')

		await session.sendMessage('A huge paste')
		await waitUntil(async () => (await failures()) === 2)
		// The note is no suspect, so the text that is itself the problem is not retried again.
		expect(sentUserText(sent[1])).toContain('content omitted')
		expect(sentUserText(sent[1])).not.toContain(REFUSED)

		await session.sendMessage('Just a question')
		await answered()
		expect(sent).toHaveLength(3)
		expect(sentUserText(sent[2])).not.toContain('A huge paste')
		expect(sentUserText(sent[2])).toContain('content omitted')
		expect(countHistoryMentions(session, 'content omitted')).toBe(1)

		await harness.shutdown()
	})

	it('a turn that fails without rejecting its content keeps the attachment queued with no note', async () => {
		const { sent, harness, session, uploadPage, failures, answered } = await entryAgentWithRefusedUpload({ unauthorizedOnce: true })
		await uploadPage('accepted.txt')

		await session.sendMessage('Put this on the about page')
		await waitUntil(async () => (await failures()) === 1)
		await session.sendMessage('Try again')
		await answered()

		expect(sent).toHaveLength(2)
		expect(sentUserText(sent[1])).toContain('[File uploaded: accepted.txt]')
		expect(sentUserText(sent[1])).not.toContain('content omitted')
		// No suspect left the turn, so its text was consumed as for a text-only turn; keeping it would retry forever.
		expect(sentUserText(sent[1])).not.toContain('Put this on the about page')
		expect(await session.getEventsByType(uploadEvents, 'attachments_rejected')).toHaveLength(0)

		await harness.shutdown()
	})

	it('an accepted turn that carried an attachment sends it without a note and consumes it', async () => {
		const { sent, harness, session, uploadPage, attachableUploads, answered } = await entryAgentWithRefusedUpload()
		const uploadId = await uploadPage('accepted.txt')

		await session.sendMessage('Put this on the about page')
		await answered()

		expect(sent).toHaveLength(1)
		expect(sentUserText(sent[0])).toContain('[File uploaded: accepted.txt]')
		expect(sentUserText(sent[0])).not.toContain('content omitted')
		// Consumption follows the commit, and its meta.json write follows the event.
		await waitUntil(async () => (await attachableUploads()).length === 0)
		const consumed = await session.getEventsByType(uploadEvents, 'attachments_consumed')
		expect(consumed.map((event) => event.uploadIds.map(String))).toEqual([[uploadId]])

		await harness.shutdown()
	})

	it('an entry agent drops the user\'s text rejected with a child\'s report, which is no suspect of its own', async () => {
		const sent: InferenceRequest[] = []
		const llmProvider = new MockLLMProvider((request) => {
			sent.push(request)
			if (sentUserText(request).includes('A huge paste')) throw { type: 'invalid_request', message: REJECTED, statusCode: 400, providerError: { statusCode: 400, body: REJECTION_BODY } }
			return { content: 'Answered', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
		})
		const base = createTestPreset()
		const rootPreset = { ...base, orchestrator: { ...base.orchestrator, errorResumeBackoff: { baseDelayMs: 1, maxDelayMs: 1 } } }
		const harness = new TestHarness({ presets: [rootPreset], llmProvider })
		const session = await harness.createSession('test')
		const entryId = session.getEntryAgentId()!
		// Held, so the report and the user's text go out in one turn.
		await session.pauseAgent(entryId, 'Hold the inputs')
		const report = await session.callPluginMethod('mailbox.send', { debug: true, toAgentId: entryId, content: 'Child report' })
		if (!report.ok) throw new Error(report.error.message)
		await session.sendMessage('A huge paste')
		await session.resumeAgent(entryId)
		await waitUntil(async () => (await session.getEventsByType(llmEvents, 'inference_failed')).length === 1)
		await Bun.sleep(50)

		expect(sent).toHaveLength(1)
		expect(sentUserText(sent[0])).toContain('Child report')
		expect(session.state.agents.get(entryId)?.status).toBe('errored')
		const consumed = await session.getEventsByType(agentEvents, 'agent_input_consumed')
		expect([...(consumed.at(-1)?.sourcePlugins ?? [])].sort()).toEqual(['mailbox', 'user-chat'])

		await session.sendAndWaitForIdle('Just a question')
		expect(sent).toHaveLength(2)
		expect(sentUserText(sent[1])).not.toContain('A huge paste')

		await harness.shutdown()
	})

	it('a helper agent drops its parent\'s message with a rejected tool-result turn, as before', async () => {
		let childCalls = 0
		const llmProvider = new MockLLMProvider((request) => {
			if (!request.systemPrompt.includes(CHILD_SYSTEM)) {
				return { content: 'Noted', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			}
			childCalls++
			if (childCalls === 1) {
				return { content: null, toolCalls: [{ id: ToolCallId('look-1'), name: 'look', input: {} }], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			}
			if (sendsImageToolResult(request)) throw { type: 'invalid_request', message: REJECTED, statusCode: 400, providerError: { statusCode: 400, body: REJECTION_BODY } }
			return { content: 'Inspected', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
		})
		const helperPreset = createTestPreset({
			agents: [{ name: 'child', system: CHILD_SYSTEM, model: CHILD_MODEL, tools: [lookTool], agents: [], errorResumeBackoff: { baseDelayMs: 1, maxDelayMs: 1 } }],
		})
		const harness = new TestHarness({ presets: [helperPreset], llmProvider })
		const session = await harness.createSession('test')
		const entryId = session.getEntryAgentId()!
		const live = await harness.sessionManager.getSession(session.sessionId)
		if (!live.ok) throw new Error(live.error.message)
		const spawned = await live.value.spawnAgentManually('child', entryId, 'Inspect the page')
		if (!spawned.ok) throw new Error(spawned.error.message)
		const childId = spawned.value
		const childFailures = async () => (await session.getEventsByType(llmEvents, 'inference_failed')).filter((e) => e.agentId === childId).length
		await waitUntil(async () => (await childFailures()) === 1)

		const note = await session.callPluginMethod('mailbox.send', { fromAgentId: entryId, toAgentId: childId, content: 'Parent note' })
		if (!note.ok) throw new Error(note.error.message)
		await waitUntil(async () => (await childFailures()) === 2)
		await Bun.sleep(100)

		// The message went out once, with the rejected turn, and was dropped with it: no retry of its own.
		expect(childCalls).toBe(3)
		expect(live.value.state.agents.get(childId)?.status).toBe('errored')
		const consumed = (await session.getEventsByType(agentEvents, 'agent_input_consumed')).filter((e) => e.agentId === childId)
		expect(consumed.at(-1)?.sourcePlugins).toEqual(['mailbox'])

		await harness.shutdown()
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
