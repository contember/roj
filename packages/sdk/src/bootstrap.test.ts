import { describe, expect, it } from 'bun:test'
import { bootstrap, createSystemFromServices } from './bootstrap.js'
import { MemoryEventStore } from './core/events/memory.js'
import type { DomainEvent } from './core/events/types.js'
import { MockLLMProvider } from './core/llm/mock.js'
import type { SessionId } from './core/sessions/schema.js'
import { createTestPreset } from './testing/index.js'
import { createNodePlatform } from './testing/node-platform.js'

/** Holds every append once stalled, so a second write has to wait for its turn in the queue. */
class StallingEventStore extends MemoryEventStore {
	stalled = false
	private releaseStall = () => {}
	private readonly stall = new Promise<void>((resolve) => {
		this.releaseStall = resolve
	})

	release(): void {
		this.releaseStall()
	}

	override async append(sessionId: SessionId, event: DomainEvent): Promise<void> {
		if (this.stalled) await this.stall
		await super.append(sessionId, event)
	}

	override async appendBatch(sessionId: SessionId, events: DomainEvent[]): Promise<void> {
		if (this.stalled) await this.stall
		await super.appendBatch(sessionId, events)
	}
}

describe('createSystemFromServices', () => {
	it('bounds the session write queue by the configured writeQueueTimeoutMs', async () => {
		const eventStore = new StallingEventStore()
		const services = bootstrap(
			{
				port: 0,
				host: 'localhost',
				dataPath: '',
				persistence: 'memory',
				logLevel: 'error',
				logFormat: 'console',
				llmMock: () => ({ content: 'Ok', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }),
				writeQueueTimeoutMs: 50,
			},
			{ presets: [createTestPreset()] },
			createNodePlatform(),
			{ eventStore },
		)
		const system = createSystemFromServices(services)
		try {
			const created = await system.sessionManager.createSession('test')
			if (!created.ok) throw new Error(created.error.message)
			const session = created.value
			const agentId = session.getEntryAgentId()
			if (!agentId) throw new Error('Expected entry agent')

			eventStore.stalled = true
			void session.pauseAgent(agentId, 'first').catch(() => {})
			const queued = session.pauseAgent(agentId, 'second').then(() => 'settled', () => 'settled')
			// The SDK default is 30 seconds, so a dropped option leaves the queued write waiting past this bound.
			const hung = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_000))
			expect(await Promise.race([queued, hung])).toBe('settled')
		} finally {
			eventStore.release()
			await system.sessionManager.shutdown()
		}
	})
})
