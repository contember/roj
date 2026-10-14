import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { BunSqliteStorage } from '@roj-ai/kompjutr-platform/testing'
import { MockLLMProvider, type MockInferenceHandler, z } from '@roj-ai/sdk'
import { createTestPreset } from '@roj-ai/sdk/testing'
import type { RuntimeBroadcast, RuntimeHost } from './host-contract.js'
import { createIsolateRuntime, type IsolateRuntime } from './runtime.js'
import { MemoryKv } from './testing.js'

const T0 = Date.parse('2026-10-12T10:00:00Z')
const RETRY_MS = 60_000

afterEach(() => setSystemTime())

class TestHost implements RuntimeHost {
	alarm: number | null = null
	readonly broadcasts: RuntimeBroadcast[] = []

	async setAlarm(scheduledTime: number) {
		this.alarm = scheduledTime
	}

	async deleteAlarm() {
		this.alarm = null
	}

	async broadcast(message: RuntimeBroadcast) {
		this.broadcasts.push(message)
	}
}

/** One Durable Object's storage, shared by every runtime booted on it — as across evictions. */
const createObject = () => ({ storage: Object.assign(new BunSqliteStorage(), { kv: new MemoryKv() }), host: new TestHost() })

const boot = (object: ReturnType<typeof createObject>, llmMock: MockInferenceHandler) =>
	createIsolateRuntime({
		userConfig: { presets: [createTestPreset({ id: 'test' })] },
		host: object.host,
		state: { storage: object.storage, waitUntil: () => {} },
		config: { llmMock, logLevel: 'error' },
		inFlightRetryMs: RETRY_MS,
	})

const createdSchema = z.object({ ok: z.literal(true), value: z.object({ sessionId: z.string() }) })
const eventsSchema = z.object({ ok: z.literal(true), value: z.object({ events: z.array(z.object({ type: z.string() })) }) })

const answering: MockInferenceHandler = () => ({ content: 'Hello.', finishReason: 'stop', toolCalls: [], metrics: MockLLMProvider.defaultMetrics() })

async function rpc(runtime: IsolateRuntime, method: string, input: Record<string, unknown>): Promise<unknown> {
	const response = await runtime.fetch(
		new Request('http://runtime/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, input }) }),
	)
	return response.json()
}

/** What the host's alarm() does: deliver whatever is due, until nothing is armed. */
async function runAlarms(runtime: IsolateRuntime, host: TestHost) {
	for (let round = 0; round < 20 && host.alarm !== null; round++) {
		setSystemTime(host.alarm)
		await runtime.deliverWakes()
	}
}

async function eventTypes(runtime: IsolateRuntime, sessionId: string): Promise<string[]> {
	const result = eventsSchema.parse(await rpc(runtime, 'sessions.getEvents', { sessionId }))
	return result.value.events.map(event => event.type)
}

describe('isolate runtime', () => {
	test('runs a session over the sandbox runtime HTTP surface, driven by the host alarm', async () => {
		setSystemTime(T0)
		const object = createObject()
		const runtime = boot(object, answering)
		await runtime.start()

		const sessionId = createdSchema.parse(await rpc(runtime, 'sessions.create', { presetId: 'test' })).value.sessionId
		expect(await rpc(runtime, 'user-chat.sendMessage', { sessionId, content: 'Hi' })).toMatchObject({ ok: true })
		expect(object.host.alarm).not.toBeNull()

		await runAlarms(runtime, object.host)

		expect(object.host.alarm).toBeNull()
		expect(await eventTypes(runtime, sessionId)).toContain('inference_completed')
		expect(object.host.broadcasts.length).toBeGreaterThan(0)
		const status = await (await runtime.fetch(new Request('http://runtime/status'))).json()
		expect(status).toMatchObject({ versions: { runtime: { name: '@roj-ai/isolate-runtime' } }, sessions: [{ id: sessionId, presetId: 'test' }] })
	})

	test('a turn lost to an eviction is retried by the alarm and finished by the next isolate', async () => {
		setSystemTime(T0)
		const object = createObject()
		const evicted = boot(object, () => new Promise(() => {}))
		await evicted.start()
		const sessionId = createdSchema.parse(await rpc(evicted, 'sessions.create', { presetId: 'test' })).value.sessionId
		await rpc(evicted, 'user-chat.sendMessage', { sessionId, content: 'Hi' })

		// The delivery hangs on the provider call, and the isolate goes away with it.
		setSystemTime(object.host.alarm ?? T0)
		void evicted.deliverWakes()
		await Bun.sleep(50)
		expect(object.host.alarm).toBe(Date.now() + RETRY_MS)

		const next = boot(object, answering)
		await next.start()
		await runAlarms(next, object.host)

		expect(object.host.alarm).toBeNull()
		expect(await eventTypes(next, sessionId)).toContain('inference_completed')
	})
})
