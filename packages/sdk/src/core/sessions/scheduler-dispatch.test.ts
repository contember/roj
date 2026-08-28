/**
 * Scheduler wake dispatch — the entry point a host calls when a delay it was
 * holding elapses.
 *
 * Most of these use a scheduler that records wakes and never fires them, which
 * is the shape of an alarm-driven host: arming and delivering are separate
 * events, and delivery may land in a process that never armed anything.
 */

import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { MemoryEventStore } from '~/core/events/memory.js'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { MockInferenceHandler } from '~/core/llm/mock.js'
import type { InferenceResponse } from '~/core/llm/provider.js'
import { agentWakeKey } from '~/core/agents/agent.js'
import { SessionId } from '~/core/sessions/schema.js'
import { pluginWakeKey, SessionManager } from '~/core/sessions/session-manager.js'
import type { Session } from '~/core/sessions/session.js'
import { ToolExecutor } from '~/core/tools/executor.js'
import { silentLogger } from '~/lib/logger/logger.js'
import type { Platform, Scheduler } from '~/platform/index.js'
import { createTimerScheduler } from '~/platform/index.js'
import { agentStatusPlugin } from '~/plugins/agent-status/plugin.js'
import { agentsPlugin } from '~/plugins/agents/plugin.js'
import { mailboxPlugin } from '~/plugins/mailbox/plugin.js'
import { presetsPlugin, sessionLifecyclePlugin } from '~/plugins/session-lifecycle/index.js'
import { userChatPlugin } from '~/plugins/user-chat/plugin.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { createTestPreset } from '~/testing/preset-helpers.js'
import { waitForAllAgentsIdle } from '~/testing/wait-helpers.js'

interface WakeOp {
	op: 'wake' | 'cancel'
	key: string
}

/** Records wakes and never fires them — the test decides when one comes due. */
class RecordingScheduler implements Scheduler {
	readonly armed = new Map<string, number>()
	readonly ops: WakeOp[] = []

	async wake(key: string, delayMs: number): Promise<void> {
		this.ops.push({ op: 'wake', key })
		this.armed.set(key, delayMs)
	}

	async cancel(key: string): Promise<void> {
		this.ops.push({ op: 'cancel', key })
		this.armed.delete(key)
	}

	opsFor(key: string): Array<WakeOp['op']> {
		return this.ops.filter((entry) => entry.key === key).map((entry) => entry.op)
	}
}

/** Poll rather than sleep: the claim is that it happens, not that it fits a fixed window. */
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline && !condition()) {
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

const okResponse = (content: string): InferenceResponse => ({
	content,
	toolCalls: [],
	finishReason: 'stop',
	metrics: MockLLMProvider.defaultMetrics(),
})

const systemPlugins = [
	sessionLifecyclePlugin,
	presetsPlugin,
	mailboxPlugin,
	agentsPlugin,
	agentStatusPlugin,
	userChatPlugin,
]

interface Host {
	manager: SessionManager
	llmProvider: MockLLMProvider
	platform: Platform
	basePath: string
}

const hosts: Host[] = []

/**
 * A SessionManager on an injectable scheduler. TestHarness always builds its own
 * platform, and the whole point here is to swap the scheduler out.
 */
function createHost(options: {
	scheduler: Scheduler
	eventStore?: MemoryEventStore
	mockHandler?: MockInferenceHandler
}): Host {
	const basePath = `/tmp/roj-wake-${Math.random().toString(36).slice(2)}`
	const platform: Platform = { ...createNodePlatform(), scheduler: options.scheduler }
	const llmProvider = new MockLLMProvider(options.mockHandler ?? (() => okResponse('done')))
	const manager = new SessionManager({
		eventStore: options.eventStore ?? new MemoryEventStore(),
		llmProvider,
		toolExecutor: new ToolExecutor(silentLogger),
		presets: new Map([['test', createTestPreset()]]),
		logger: silentLogger,
		basePath,
		dataFileStore: new SessionFileStore(basePath, undefined, false, platform.fs, 'session'),
		platform,
		systemPlugins,
	})
	const host: Host = { manager, llmProvider, platform, basePath }
	hosts.push(host)
	return host
}

async function createSession(host: Host): Promise<Session> {
	const result = await host.manager.createSession('test')
	if (!result.ok) throw new Error(`createSession failed: ${result.error.type}`)
	return result.value
}

/** Queue work for the entry agent, which is what arms its debounce wake. */
async function sendMessage(session: Session, agentId: AgentId, content: string): Promise<void> {
	const result = await session.callPluginMethod('mailbox.send', { toAgentId: agentId, content, debug: true })
	if (!result.ok) throw new Error(`mailbox.send failed: ${result.error.type}`)
}

function entryAgentId(session: Session): AgentId {
	const agentId = session.getEntryAgentId()
	if (!agentId) throw new Error('No entry agent')
	return agentId
}

afterEach(async () => {
	const pending = hosts.splice(0, hosts.length)
	for (const host of pending) {
		await host.manager.shutdown()
		await rm(host.basePath, { recursive: true, force: true })
	}
})

describe('SessionManager.dispatchWake', () => {
	it('runs the turn the debounce wake stands for, instead of re-arming it', async () => {
		const scheduler = new RecordingScheduler()
		const host = createHost({ scheduler })
		const session = await createSession(host)
		const agentId = entryAgentId(session)

		await sendMessage(session, agentId, 'hello')

		// Nothing ran: the delay is held by the host, not by a timer in this process.
		const key = agentWakeKey(session.id, agentId, 'debounce')
		expect(scheduler.armed.has(key)).toBe(true)
		expect(host.llmProvider.getCallCount()).toBe(0)

		scheduler.armed.clear()
		await host.manager.dispatchWake(key)

		expect(host.llmProvider.getCallCount()).toBe(1)
		// The re-entrancy trap: a resumed debounce must not arm the same wake again.
		expect(scheduler.armed.has(key)).toBe(false)
	})

	it('boots the session and runs the turn when the wake lands in a fresh process', async () => {
		const eventStore = new MemoryEventStore()

		// Process 1 arms the wake and never gets to deliver it.
		const first = createHost({ scheduler: new RecordingScheduler(), eventStore })
		const session = await createSession(first)
		const sessionId = session.id
		const agentId = entryAgentId(session)
		await sendMessage(session, agentId, 'hello')

		const key = agentWakeKey(sessionId, agentId, 'debounce')
		expect(first.llmProvider.getCallCount()).toBe(0)
		await first.manager.shutdown()

		// Process 2: same event log, nothing in memory — the key is the only input.
		// Loading the session is itself part of the delivery, and is why the queued
		// turn runs: a dispatchWake that routed nowhere would load nothing.
		const second = createHost({ scheduler: new RecordingScheduler(), eventStore })
		await second.manager.dispatchWake(key)
		await waitUntil(() => second.llmProvider.getCallCount() > 0)

		expect(second.llmProvider.getCallCount()).toBe(1)
		const reopened = await second.manager.getSession(sessionId)
		expect(reopened.ok).toBe(true)
		if (!reopened.ok) return
		const history = reopened.value.state.agents.get(agentId)?.conversationHistory ?? []
		expect(history.some((message) => message.role === 'assistant')).toBe(true)
	})

	it('routes a plugin wake to its method on a session this process has never seen', async () => {
		const eventStore = new MemoryEventStore()

		const first = createHost({ scheduler: new RecordingScheduler(), eventStore })
		const session = await createSession(first)
		const sessionId = session.id
		const agentId = entryAgentId(session)
		await first.manager.shutdown()

		// Nothing but the key: no live session, and pausing is not something a plain
		// reload would do on its own.
		const second = createHost({ scheduler: new RecordingScheduler(), eventStore })
		await second.manager.dispatchWake(pluginWakeKey(sessionId, 'agents', 'pause', agentId))

		const reopened = await second.manager.getSession(sessionId)
		expect(reopened.ok).toBe(true)
		if (!reopened.ok) return
		expect(reopened.value.state.agents.get(agentId)?.status).toBe('paused')
	})

	it('hands a due retry wake back to normal scheduling', async () => {
		const scheduler = new RecordingScheduler()
		let calls = 0
		const host = createHost({
			scheduler,
			mockHandler: () => {
				calls++
				throw { type: 'rate_limit', message: 'slow down', retryAfterMs: 0 }
			},
		})
		const session = await createSession(host)
		const agentId = entryAgentId(session)
		const debounceKey = agentWakeKey(session.id, agentId, 'debounce')
		const retryKey = agentWakeKey(session.id, agentId, 'retry')

		// The turn burns its inner retries, then the outer backoff arms a retry wake.
		await sendMessage(session, agentId, 'hello')
		await host.manager.dispatchWake(debounceKey)
		expect(calls).toBeGreaterThan(0)
		expect(scheduler.armed.has(retryKey)).toBe(true)

		// Delivering it re-enters scheduling rather than inference — continue() re-checks
		// the remaining backoff for itself.
		scheduler.armed.clear()
		await host.manager.dispatchWake(retryKey)
		expect(scheduler.armed.has(debounceKey)).toBe(true)
	})

	it('cancels before it re-arms, so a schedule cannot lose its own wake', async () => {
		const scheduler = new RecordingScheduler()
		const host = createHost({ scheduler })
		const session = await createSession(host)
		const agentId = entryAgentId(session)
		const key = agentWakeKey(session.id, agentId, 'debounce')

		await sendMessage(session, agentId, 'hello')

		// scheduleProcessing() issues both without awaiting either. A cancel that landed
		// after the arm would swallow the wake and the turn would never run.
		expect(scheduler.opsFor(key)).toEqual(['cancel', 'wake'])
		expect(scheduler.armed.has(key)).toBe(true)

		await host.manager.dispatchWake(key)
		expect(host.llmProvider.getCallCount()).toBe(1)
	})

	it('delivers its own wakes on a live scheduler, without anything calling dispatchWake', async () => {
		const host = createHost({ scheduler: createTimerScheduler() })
		const session = await createSession(host)
		const agentId = entryAgentId(session)

		await sendMessage(session, agentId, 'hello')
		await waitForAllAgentsIdle(session)

		expect(host.llmProvider.getCallCount()).toBe(1)
	})

	it('is a no-op for a wake whose session, agent or plugin is gone', async () => {
		const host = createHost({ scheduler: new RecordingScheduler() })
		const session = await createSession(host)

		await host.manager.dispatchWake(agentWakeKey(SessionId('never-existed'), AgentId('orchestrator_1'), 'debounce'))
		await host.manager.dispatchWake(agentWakeKey(session.id, AgentId('ghost_9'), 'debounce'))
		await host.manager.dispatchWake(pluginWakeKey(session.id, 'no-such-plugin', 'tick', AgentId('orchestrator_1')))

		expect(host.llmProvider.getCallCount()).toBe(0)
	})

	it('ignores a key it did not mint', async () => {
		const host = createHost({ scheduler: new RecordingScheduler() })
		await createSession(host)

		await host.manager.dispatchWake('not-a-wake-key')
		await host.manager.dispatchWake('agent:s1:a1:nonsense')
		await host.manager.dispatchWake('services:s1:restart')

		expect(host.llmProvider.getCallCount()).toBe(0)
	})
})
