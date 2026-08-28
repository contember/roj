/**
 * Tests for Agent shutdown behavior - verifying that session close
 * prevents re-scheduling and aborts in-flight work.
 */

import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { agentEvents } from '~/core/agents/state.js'
import { MemoryEventStore } from '~/core/events'
import { withSessionId } from '~/core/events/test-helpers.js'
import { MockLLMProvider } from '~/core/llm/index.js'
import type { InferenceResponse, LLMError } from '~/core/llm/provider.js'
import { ModelId } from '~/core/llm/schema.js'
import { createApplyEvent } from '~/core/sessions/apply-event.js'
import type { SessionContext } from '~/core/sessions/context.js'
import { SessionRuntimeActivityController } from '~/core/sessions/runtime-activity.js'
import { SessionId } from '~/core/sessions/schema.js'
import { sessionEvents } from '~/core/sessions/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { mailboxPlugin } from '~/plugins/mailbox/plugin.js'
import { generateTestMessageId } from '~/plugins/mailbox/schema.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import { isLiveScheduler } from '~/platform/index.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { ConsoleLogger } from '../../lib/logger/console.js'
import { SessionFileStore } from '../file-store/file-store.js'
import { SessionStore } from '../sessions/session-store.js'
import { ToolExecutor } from '../tools/executor.js'
import { parseAgentWakeKey } from '~/core/wake-key.js'
import { Agent, type AgentConfig, type AgentDependencies } from './agent.js'

// ============================================================================
// Test Helpers
// ============================================================================

const TEST_SESSION_ID = SessionId('test-session')
const TEST_AGENT_ID = AgentId('test-agent-1')
/** Retryable, with a zero retry-after so the inner LLM retries burn no wall clock. */
const RATE_LIMITED: LLMError = { type: 'rate_limit', message: 'slow down', retryAfterMs: 0 }

function createLogger() {
	return new ConsoleLogger({ level: 'error' })
}

async function createTestAgent(
	config: Partial<AgentConfig> = {},
	llmResponse?: Partial<InferenceResponse>,
	provider?: MockLLMProvider,
): Promise<{
	agent: Agent
	store: SessionStore
	eventStore: MemoryEventStore
	llmProvider: MockLLMProvider
	runtimeActivity: SessionRuntimeActivityController
}> {
	const eventStore = new MemoryEventStore()
	const logger = createLogger()

	// Create session
	const sessionCreatedEvent = withSessionId(TEST_SESSION_ID, sessionEvents.create('session_created', { presetId: 'test-preset' }))
	await eventStore.append(TEST_SESSION_ID, sessionCreatedEvent)

	// Spawn agent
	const agentSpawnedEvent = withSessionId(
		TEST_SESSION_ID,
		agentEvents.create('agent_spawned', {
			agentId: TEST_AGENT_ID,
			definitionName: 'test-agent',
			parentId: null,
		}),
	)
	await eventStore.append(TEST_SESSION_ID, agentSpawnedEvent)

	const composedReducer = createApplyEvent([mailboxPlugin.create({})])
	const store = await SessionStore.load(TEST_SESSION_ID, eventStore, composedReducer)
	if (!store) {
		throw new Error('Failed to create SessionStore')
	}

	const defaultConfig: AgentConfig = {
		systemPrompt: 'Test system prompt',
		tools: [],
		model: ModelId('test-model'),
		spawnableAgents: [],
		debounceMs: 0,
		...config,
	}

	const llmProvider = provider ?? MockLLMProvider.withFixedResponse({
		content: llmResponse?.content ?? 'Test response',
		toolCalls: llmResponse?.toolCalls ?? [],
		finishReason: llmResponse?.finishReason ?? 'stop',
	})

	const fileStore = new SessionFileStore('/tmp/test', undefined, false, createNodePlatform().fs)

	const runtimeActivity = new SessionRuntimeActivityController()
	const platform = createNodePlatform()
	let nextMailboxMessageSequence = 1
	const sessionContext: SessionContext = {
		sessionId: TEST_SESSION_ID,
		sessionState: store.getState(),
		getSessionState: () => store.getState(),
		sessionInput: undefined,
		environment: { sessionDir: '/tmp/test', sandboxed: false },
		llm: llmProvider,
		files: fileStore,
		eventStore,
		platform,
		logger,
		runtimeActivity,
		reserveSequence: (_name, seed) => seed(),
		reserveMailboxMessageSequence: () => nextMailboxMessageSequence++,
		emitEvent: async (event) => {
			await store.emit(withSessionId(TEST_SESSION_ID, event))
		},
		emitEvents: async (events) => {
			await store.emitBatch(events.map((event) => withSessionId(TEST_SESSION_ID, event)))
		},
		notify: () => {},
	}

	const deps: AgentDependencies = {
		id: TEST_AGENT_ID,
		getSessionContext: () => ({ ...sessionContext, sessionState: store.getState() }),
		store,
		llmProvider,
		toolExecutor: new ToolExecutor(logger),
		logger,
		config: defaultConfig,
		plugins: [mailboxPlugin.create({})],
		environment: { sessionDir: '/tmp/test', sandboxed: false },
		fileStore,
	}

	const agent = new Agent(deps)
	// Stand-in for SessionManager.dispatchWake: without it a bare Agent arms wakes
	// that nothing delivers, because the wake carries no closure to run.
	const scheduler = platform.scheduler
	if (isLiveScheduler(scheduler)) {
		scheduler.onWake((key) => {
			const wake = parseAgentWakeKey(key)
			if (wake) return agent.deliverWake(wake.kind)
		})
	}
	return { agent, store, eventStore, llmProvider, runtimeActivity }
}

async function addMailboxMessage(store: SessionStore, content: string) {
	await store.emit(withSessionId(
		TEST_SESSION_ID,
		mailboxEvents.create('mailbox_message', {
			toAgentId: TEST_AGENT_ID,
			message: {
				id: generateTestMessageId(),
				from: 'user',
				content,
				timestamp: Date.now(),
				consumed: false,
			},
		}),
	))
}

async function closeSession(store: SessionStore) {
	await store.emit(withSessionId(TEST_SESSION_ID, sessionEvents.create('session_closed', {})))
}

/**
 * Wait for any scheduled timers to fire.
 */
async function flushTimers() {
	await new Promise<void>((resolve) => setTimeout(resolve, 10))
}

/** Poll until the condition holds, so timing assertions don't ride on wall clock. */
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline && !condition()) {
		await new Promise<void>((resolve) => setTimeout(resolve, 5))
	}
}

// ============================================================================
// Tests
// ============================================================================

describe('Agent Shutdown', () => {
	it('continue() is no-op when session is closed', async () => {
		const { agent, store, llmProvider, eventStore } = await createTestAgent()

		await addMailboxMessage(store, 'Hello')
		await closeSession(store)

		await agent.continue()

		expect(llmProvider.getCallCount()).toBe(0)

		const events = await eventStore.load(TEST_SESSION_ID)
		const inferenceStarted = events.filter(e => e.type === 'inference_started')
		expect(inferenceStarted).toHaveLength(0)
	})

	it('agent does not continue after session closes', async () => {
		const { agent, store, llmProvider } = await createTestAgent()

		await addMailboxMessage(store, 'Hello')
		// While loop runs full cycle: onStart → inference → onComplete
		await agent.continue()
		expect(llmProvider.getCallCount()).toBe(1)

		// Close session
		await closeSession(store)

		// Add another message that would trigger work if continue() ran
		await addMailboxMessage(store, 'Another message')

		// Let any scheduled timers fire
		await flushTimers()

		// No additional inference should have occurred — isClosed() guard blocks re-entry
		expect(llmProvider.getCallCount()).toBe(1)
	})

	it('agent does not run additional inference after session is closed', async () => {
		const { agent, store, llmProvider } = await createTestAgent(
			{},
			{ toolCalls: [{ id: ToolCallId('tc-1'), name: 'test_tool', input: {} }] },
		)

		await addMailboxMessage(store, 'Hello')
		// While loop runs full cycle: inference → tool_exec → scheduleProcessing
		await agent.continue()
		expect(llmProvider.getCallCount()).toBe(1)

		// Close session — any scheduled timer will find isClosed() and stop
		await closeSession(store)

		// Calling continue() again is a no-op when session is closed
		await agent.continue()

		// No additional inference should have occurred
		expect(llmProvider.getCallCount()).toBe(1)
	})

	it('scheduleProcessing() is no-op when session is closed', async () => {
		const { agent, store } = await createTestAgent()

		await addMailboxMessage(store, 'Hello')
		await closeSession(store)

		agent.scheduleProcessing()

		expect(agent.isScheduled()).toBe(false)
	})

	it('shutdown() stops scheduled processing', async () => {
		const { agent, store, llmProvider, runtimeActivity } = await createTestAgent({
			debounceMs: 100,
		})

		await addMailboxMessage(store, 'Hello')
		agent.scheduleProcessing()
		expect(agent.isScheduled()).toBe(true)
		expect(runtimeActivity.getSnapshot().reasons).toEqual({ [`agent:${TEST_AGENT_ID}:scheduled`]: 1 })

		agent.shutdown()
		expect(agent.isScheduled()).toBe(false)
		expect(runtimeActivity.getSnapshot().activeCount).toBe(0)

		// Wait longer than the debounce time
		await new Promise<void>((resolve) => setTimeout(resolve, 150))

		// LLM should never have been called
		expect(llmProvider.getCallCount()).toBe(0)
	})

	it('a throwing debounceCallback releases the scheduled lease', async () => {
		const { agent, store, runtimeActivity } = await createTestAgent({
			debounceMs: 0,
			checkIntervalMs: 5,
			debounceCallback: () => {
				throw new Error('preset callback blew up')
			},
		})

		await addMailboxMessage(store, 'Hello')
		agent.scheduleProcessing()
		expect(runtimeActivity.getSnapshot().activeCount).toBe(1)

		// The timer body must swallow the throw and cancel the schedule; otherwise the
		// lease is held forever and the runtime can never be evicted.
		await new Promise<void>((resolve) => setTimeout(resolve, 60))

		expect(agent.isScheduled()).toBe(false)
		expect(runtimeActivity.getSnapshot().activeCount).toBe(0)
	})

	it('a rejecting debounceCallback releases the scheduled lease', async () => {
		const { agent, store, runtimeActivity } = await createTestAgent({
			debounceMs: 0,
			checkIntervalMs: 5,
			debounceCallback: () => Promise.reject(new Error('preset callback rejected')),
		})

		await addMailboxMessage(store, 'Hello')
		agent.scheduleProcessing()
		await new Promise<void>((resolve) => setTimeout(resolve, 60))

		expect(agent.isScheduled()).toBe(false)
		expect(runtimeActivity.getSnapshot().activeCount).toBe(0)
	})

	it('continue() releases the scheduled lease even when the session is already closed', async () => {
		const { agent, store, runtimeActivity } = await createTestAgent({ debounceMs: 100 })

		await addMailboxMessage(store, 'Hello')
		agent.scheduleProcessing()
		expect(runtimeActivity.getSnapshot().activeCount).toBe(1)

		// close() runs while the debounce timer is still armed — continue() fires next
		// and used to early-return above the release.
		await closeSession(store)
		await agent.continue()

		expect(runtimeActivity.getSnapshot().activeCount).toBe(0)
	})

	it('the error-resume backoff holds no lease, so a failing provider stays evictable', async () => {
		const { agent, store, runtimeActivity } = await createTestAgent(
			{ errorResumeBackoff: { baseDelayMs: 5_000, maxDelayMs: 5_000 } },
			undefined,
			MockLLMProvider.withError(RATE_LIMITED),
		)

		await addMailboxMessage(store, 'Hello')
		await agent.continue()
		// Inverted from "continue() keeps the error-retry lease while its timer is still
		// armed". Leasing the wait made a session whose provider never recovers
		// permanently resident — the exact retention this PR bounds. The lease now lives
		// inside the retry callback, so the backoff itself pins nothing.
		expect(runtimeActivity.getSnapshot().activeCount).toBe(0)

		// A second continue() (a new user message during the backoff) must not strand one either.
		await agent.continue()
		expect(runtimeActivity.getSnapshot().activeCount).toBe(0)
		expect(runtimeActivity.tryBeginUnload()).toBe(true)

		agent.shutdown()
	})

	it('the error-retry timer fires, recovers, and leaves no lease behind', async () => {
		let failNext = true
		const provider = new MockLLMProvider(() => {
			if (failNext) throw RATE_LIMITED
			return { content: 'recovered', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
		})
		const { agent, store, runtimeActivity } = await createTestAgent(
			{ errorResumeBackoff: { baseDelayMs: 20, maxDelayMs: 20 } },
			undefined,
			provider,
		)

		await addMailboxMessage(store, 'Hello')
		await agent.continue()
		// withLLMRetry burns its five attempts, then the outer backoff takes over — unleased.
		expect(provider.getCallCount()).toBe(5)
		expect(runtimeActivity.getSnapshot().activeCount).toBe(0)

		failNext = false
		// Poll rather than sleep a fixed window: the claim is "the retry fired and the
		// lease it took is gone", not "that happened inside 200ms of loaded-CI wall clock".
		await waitUntil(() => provider.getCallCount() >= 6 && runtimeActivity.getSnapshot().activeCount === 0)

		expect(provider.getCallCount()).toBe(6)
		expect(store.getAgentState(TEST_AGENT_ID)?.status).toBe('pending')
		expect(runtimeActivity.getSnapshot().activeCount).toBe(0)
	})

	it('scheduleErrorRetry() refuses to re-arm after shutdown()', async () => {
		const { agent, store, runtimeActivity } = await createTestAgent(
			{ errorResumeBackoff: { baseDelayMs: 200, maxDelayMs: 200 } },
			undefined,
			MockLLMProvider.withError(RATE_LIMITED),
		)

		await addMailboxMessage(store, 'Hello')
		await agent.continue()
		agent.shutdown()

		// A turn still draining after shutdown() reaches resume_from_error again. The
		// store is NOT closed on the forced-unload path, so only the abort guard stops it
		// from arming a timer that keeps this Agent — and through getSessionContext the
		// whole Session — reachable for the rest of the backoff.
		await agent.continue()
		const idleSince = runtimeActivity.getSnapshot().lastActivityAt
		await new Promise<void>((resolve) => setTimeout(resolve, 400))

		// A fired retry callback would have touched the runtime to take its lease.
		expect(runtimeActivity.getSnapshot().lastActivityAt).toBe(idleSince)
	})

	it('waitForIdle() waits for a turn that outlives shutdown()', async () => {
		let releaseInference = () => {}
		const inferenceGate = new Promise<void>((resolve) => {
			releaseInference = resolve
		})
		// The mock ignores the abort signal, like a tool that never checks it.
		const provider = new MockLLMProvider(async () => {
			await inferenceGate
			return { content: 'late', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
		})
		const { agent, store } = await createTestAgent({}, undefined, provider)

		await addMailboxMessage(store, 'Hello')
		const turn = agent.continue()
		await new Promise<void>((resolve) => setTimeout(resolve, 20))
		expect(provider.getCallCount()).toBe(1)

		agent.shutdown()
		let drained = false
		const drain = agent.waitForIdle().then(() => {
			drained = true
		})
		await new Promise<void>((resolve) => setTimeout(resolve, 20))
		expect(drained).toBe(false)

		releaseInference()
		await drain
		expect(drained).toBe(true)
		await turn
	})
})
