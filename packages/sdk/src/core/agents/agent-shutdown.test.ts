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
import type { InferenceResponse } from '~/core/llm/provider.js'
import { ModelId } from '~/core/llm/schema.js'
import { createApplyEvent } from '~/core/sessions/apply-event.js'
import type { SessionContext } from '~/core/sessions/context.js'
import { SessionId } from '~/core/sessions/schema.js'
import { sessionEvents } from '~/core/sessions/state.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { mailboxPlugin } from '~/plugins/mailbox/plugin.js'
import { generateTestMessageId } from '~/plugins/mailbox/schema.js'
import { mailboxEvents } from '~/plugins/mailbox/state.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { ConsoleLogger } from '../../lib/logger/console.js'
import { SessionFileStore } from '../file-store/file-store.js'
import { SessionStore } from '../sessions/session-store.js'
import { ToolExecutor } from '../tools/executor.js'
import { Agent, type AgentConfig, type AgentDependencies } from './agent.js'

// ============================================================================
// Test Helpers
// ============================================================================

const TEST_SESSION_ID = SessionId('test-session')
const TEST_AGENT_ID = AgentId('test-agent-1')

function createLogger() {
	return new ConsoleLogger({ level: 'error' })
}

async function createTestAgent(
	config: Partial<AgentConfig> = {},
	llmResponse?: Partial<InferenceResponse>,
): Promise<{ agent: Agent; store: SessionStore; eventStore: MemoryEventStore; llmProvider: MockLLMProvider }> {
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

	const llmProvider = MockLLMProvider.withFixedResponse({
		content: llmResponse?.content ?? 'Test response',
		toolCalls: llmResponse?.toolCalls ?? [],
		finishReason: llmResponse?.finishReason ?? 'stop',
	})

	const fileStore = new SessionFileStore('/tmp/test', undefined, false, createNodePlatform().fs)

	const sessionContext: SessionContext = {
		sessionId: TEST_SESSION_ID,
		sessionState: store.getState(),
		sessionInput: undefined,
		environment: { sessionDir: '/tmp/test', sandboxed: false },
		llm: llmProvider,
		files: fileStore,
		eventStore,
		platform: createNodePlatform(),
		logger,
		emitEvent: async (event) => {
			await store.emit(withSessionId(TEST_SESSION_ID, event))
		},
		notify: () => {},
	}

	const deps: AgentDependencies = {
		id: TEST_AGENT_ID,
		sessionContext,
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
	return { agent, store, eventStore, llmProvider }
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
		const { agent, store, llmProvider } = await createTestAgent({
			debounceMs: 100,
		})

		await addMailboxMessage(store, 'Hello')
		agent.scheduleProcessing()
		expect(agent.isScheduled()).toBe(true)

		agent.shutdown()
		expect(agent.isScheduled()).toBe(false)

		// Wait longer than the debounce time
		await new Promise<void>((resolve) => setTimeout(resolve, 150))

		// LLM should never have been called
		expect(llmProvider.getCallCount()).toBe(0)
	})
})
