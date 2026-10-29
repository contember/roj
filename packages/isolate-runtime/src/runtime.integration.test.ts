import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { BunSqliteStorage } from '@roj-ai/kompjutr-platform/testing'
import { createEventsFactory, definePlugin, Err, type LLMMessage, MockLLMProvider, type MockInferenceHandler, Ok, ToolCallId, z } from '@roj-ai/sdk'
import { createTool } from '@roj-ai/sdk/tools'
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
	/** While set, alarm writes wait for it, as a facet's parent does until the facet's `blockConcurrencyWhile` ends. */
	gate: Promise<void> | null = null

	async setAlarm(scheduledTime: number) {
		await this.gate
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

/** Four photos of ~1.5 MB base64 each, as a camera upload hands them over: together far past one 2 MB row. */
const PHOTOS = Array.from({ length: 4 }, (_, index) => `data:image/jpeg;base64,${Buffer.alloc(1_100_000, index + 1).toString('base64')}`)

const photosPlugin = definePlugin('photos')
	.tools(() => [
		createTool({
			name: 'take_photos',
			description: 'Return the photos',
			input: z.object({}),
			execute: async () => Ok(PHOTOS.map((url) => ({ type: 'image_url' as const, imageUrl: { url } }))),
		}),
	])
	.build()

const callbackEvents = createEventsFactory({
	events: {
		callback_registered: z.object({ endpoint: z.string(), token: z.string() }),
	},
})

/**
 * A third-party plugin, built from public exports only, that a host hands a callback over RPC.
 * Its state is reduced from its own events, so the next isolate rebuilds it from the log.
 */
const callbackPlugin = definePlugin('callback')
	.events([callbackEvents])
	.state({
		key: 'callback',
		initial: (): { endpoint: string; token: string } | null => null,
		reduce: (state, event) => event.type === 'callback_registered' ? { endpoint: event.endpoint, token: event.token } : state,
	})
	.method('register', {
		input: z.object({ endpoint: z.string(), token: z.string() }),
		output: z.object({}),
		handler: async (ctx, input) => {
			await ctx.emitEvent(callbackEvents.create('callback_registered', input))
			return Ok({})
		},
	})
	.method('get', {
		input: z.object({}),
		output: z.object({ endpoint: z.string(), token: z.string() }).nullable(),
		handler: async (ctx) => Ok(ctx.pluginState),
	})
	.tools((ctx) => [
		createTool({
			name: 'call_back',
			description: 'Report to the host',
			input: z.object({}),
			execute: async () => {
				const callback = await ctx.self.get({})
				if (!callback.ok || callback.value === null) return Err({ message: 'no callback registered', recoverable: false })
				return Ok(`${callback.value.endpoint} ${callback.value.token}`)
			},
		}),
	])
	.build()

const boot = (object: ReturnType<typeof createObject>, llmMock: MockInferenceHandler) =>
	createIsolateRuntime({
		userConfig: { presets: [createTestPreset({ id: 'test', plugins: [photosPlugin.configure(), callbackPlugin.configure()] })] },
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

/** Leaves a turn in flight on the provider call, then drops the isolate, as an eviction does. */
async function evictMidTurn(object: ReturnType<typeof createObject>): Promise<string> {
	const evicted = boot(object, () => new Promise(() => {}))
	await evicted.start()
	const sessionId = createdSchema.parse(await rpc(evicted, 'sessions.create', { presetId: 'test' })).value.sessionId
	await rpc(evicted, 'user-chat.sendMessage', { sessionId, content: 'Hi' })
	setSystemTime(object.host.alarm ?? T0)
	void evicted.deliverWakes()
	await Bun.sleep(50)
	return sessionId
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

	test('a turn whose tool returns large inline photos completes, and no event row holds them', async () => {
		setSystemTime(T0)
		const object = createObject()
		const requests: LLMMessage[][] = []
		const runtime = boot(object, (request) => {
			requests.push(request.messages)
			if (requests.length > 1) return answering(request)
			return {
				content: null,
				toolCalls: [{ id: ToolCallId('tc1'), name: 'take_photos', input: {} }],
				finishReason: 'tool_calls',
				metrics: MockLLMProvider.defaultMetrics(),
			}
		})
		await runtime.start()

		const sessionId = createdSchema.parse(await rpc(runtime, 'sessions.create', { presetId: 'test' })).value.sessionId
		await rpc(runtime, 'user-chat.sendMessage', { sessionId, content: 'Take the photos.' })
		await runAlarms(runtime, object.host)

		expect(await eventTypes(runtime, sessionId)).toContain('inference_completed')
		expect(requests).toHaveLength(2)
		const toolMessage = requests[1]?.find((message) => message.role === 'tool')
		expect(toolMessage?.content).toEqual(PHOTOS.map(() => ({ type: 'image_url', imageUrl: { url: expect.stringMatching(/^file:\/\/\.images\/[0-9a-f]{64}\.jpg$/) } })))
		const largest = object.storage.db.query<{ size: number }, []>('SELECT MAX(length(payload)) AS size FROM roj_events').get()
		expect(largest?.size).toBeLessThan(64 * 1024)
	})

	test('a turn lost to an eviction is retried by the alarm and finished by the next isolate', async () => {
		setSystemTime(T0)
		const object = createObject()
		const sessionId = await evictMidTurn(object)
		expect(object.host.alarm).toBe(Date.now() + RETRY_MS)

		const next = boot(object, answering)
		await next.start()
		await runAlarms(next, object.host)

		expect(object.host.alarm).toBeNull()
		expect(await eventTypes(next, sessionId)).toContain('inference_completed')
	})

	test('plugin state a host set over RPC survives an eviction and reaches a tool in the next isolate', async () => {
		setSystemTime(T0)
		const object = createObject()
		const evicted = boot(object, () => new Promise(() => {}))
		await evicted.start()
		const sessionId = createdSchema.parse(await rpc(evicted, 'sessions.create', { presetId: 'test' })).value.sessionId
		expect(await rpc(evicted, 'callback.register', { sessionId, endpoint: 'https://host.example/hook', token: 't-123' })).toMatchObject({ ok: true })
		await rpc(evicted, 'user-chat.sendMessage', { sessionId, content: 'Report back.' })
		setSystemTime(object.host.alarm ?? T0)
		void evicted.deliverWakes()
		await Bun.sleep(50)

		const results: string[] = []
		const next = boot(object, (request) => {
			const last = request.messages[request.messages.length - 1]
			if (last?.role === 'tool') {
				results.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content))
				return answering(request)
			}
			return { content: null, toolCalls: [{ id: ToolCallId('tc1'), name: 'call_back', input: {} }], finishReason: 'tool_calls', metrics: MockLLMProvider.defaultMetrics() }
		})
		await next.start()
		await runAlarms(next, object.host)

		expect(results).toEqual(['https://host.example/hook t-123'])
		expect(await eventTypes(next, sessionId)).toContain('inference_completed')
	})

	test('start does not wait on the host, which cannot answer a facet that is still starting', async () => {
		setSystemTime(T0)
		const object = createObject()
		await evictMidTurn(object)
		const { promise: gate, resolve: openGate } = Promise.withResolvers<void>()
		const restarted = { storage: object.storage, host: new TestHost() }
		restarted.host.gate = gate

		const next = boot(restarted, answering)
		expect(await Promise.race([next.start().then(() => 'started'), Bun.sleep(100).then(() => 'blocked')])).toBe('started')

		openGate()
		await next.fetch(new Request('http://runtime/status'))
		expect(restarted.host.alarm).toBe(Date.now() + RETRY_MS)
	})
})
