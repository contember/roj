import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { EventAppendError, EventAppendOutcomeUnknownError } from '~/core/events/event-store.js'
import { MemoryEventStore } from '~/core/events/memory.js'
import type { DomainEvent } from '~/core/events/types.js'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import type { UserChatState } from './plugin.js'

function gate() {
	let release = () => {}
	const promise = new Promise<void>((resolve) => { release = resolve })
	return { promise, release }
}

class DeliveryStore extends MemoryEventStore {
	entered = gate()
	released = gate()
	hold = false
	failure: 'definite' | 'unknown' | undefined
	override async append(sessionId: SessionId, event: DomainEvent): Promise<void> {
		await this.appendBatch(sessionId, [event])
	}
	override async appendBatch(sessionId: SessionId, events: DomainEvent[]): Promise<void> {
		if (events.some((event) => event.type === 'user_chat_message_received')) {
			this.entered.release()
			if (this.hold) await this.released.promise
			const failure = this.failure
			this.failure = undefined
			if (failure === 'definite') throw new EventAppendError(sessionId)
			await super.appendBatch(sessionId, events)
			if (failure === 'unknown') throw new EventAppendOutcomeUnknownError(sessionId)
			return
		}
		await super.appendBatch(sessionId, events)
	}
}

describe('user-chat delivery receipts', () => {
	const harnesses: TestHarness[] = []
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.shutdown()
	})
	function harness(eventStore: MemoryEventStore = new DeliveryStore()) {
		const result = new TestHarness({ presets: [createTestPreset()], eventStore })
		harnesses.push(result)
		return result
	}
	async function paused(owner: TestHarness) {
		const session = await owner.createSession('test')
		const agentId = session.getEntryAgentId()
		if (!agentId) throw new Error('Expected entry agent')
		await session.pauseAgent(agentId, 'Inspect delivery acceptance')
		return { session, agentId }
	}

	it('replays sequential and concurrent requests without another event or ID reservation', async () => {
		const owner = harness()
		const { session } = await paused(owner)
		const input = { deliveryId: 'opaque /\u0000 ID', content: 'Hello' }
		const results = await Promise.all(Array.from({ length: 8 }, () => session.callPluginMethod('user-chat.sendMessage', input)))
		for (const result of results) expect(result).toEqual(results[0])
		expect(results[0]).toEqual({ ok: true, value: { messageId: 'm1' } })
		expect(await session.callPluginMethod('user-chat.sendMessage', input)).toEqual(results[0])
		const events = await session.getEventsByType('user_chat_message_received')
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({ delivery: { id: input.deliveryId, fingerprint: '164aa12c770ae794d102fb0ba698830f397b9298c07421f8a7732b497be0fda0' } })
		expect(await session.callPluginMethod('user-chat.sendMessage', { content: 'Legacy' })).toEqual({ ok: true, value: { messageId: 'm2' } })
	})

	it('conflicts immediately while append is held and matching requests join', async () => {
		const store = new DeliveryStore()
		const { session } = await paused(harness(store))
		store.hold = true
		const input = { deliveryId: 'overlap', content: 'Original' }
		const first = session.callPluginMethod('user-chat.sendMessage', input)
		await store.entered.promise
		try {
			const conflict = await session.callPluginMethod('user-chat.sendMessage', { ...input, content: 'Different' })
			expect(conflict).toMatchObject({ ok: false, error: { type: 'user_chat_delivery_conflict', httpStatus: 409 } })
			const joined = session.callPluginMethod('user-chat.sendMessage', input)
			store.released.release()
			expect(await joined).toEqual(await first)
			expect(await session.getEventsByType('user_chat_message_received')).toHaveLength(1)
		} finally {
			store.released.release()
			await first
		}
	})

	it('uses the supplied target, not the resolved entry agent, in request identity', async () => {
		const { session, agentId } = await paused(harness())
		const input = { deliveryId: 'target', content: 'Hello' }
		expect((await session.callPluginMethod('user-chat.sendMessage', input)).ok).toBe(true)
		for (const target of [agentId, AgentId('another-agent')]) {
			expect(await session.callPluginMethod('user-chat.sendMessage', { ...input, agentId: target })).toMatchObject({ ok: false, error: { type: 'user_chat_delivery_conflict' } })
		}
		const explicit = { ...input, deliveryId: 'explicit', agentId }
		const accepted = await session.callPluginMethod('user-chat.sendMessage', explicit)
		expect(await session.callPluginMethod('user-chat.sendMessage', explicit)).toEqual(accepted)
		expect(await session.callPluginMethod('user-chat.sendMessage', { ...explicit, agentId: AgentId('another-agent') })).toMatchObject({ ok: false, error: { type: 'user_chat_delivery_conflict' } })
	})

	it('scopes IDs to sessions and accepts distinct IDs for identical content', async () => {
		const owner = harness()
		const first = await paused(owner)
		const second = await paused(owner)
		for (const { session } of [first, second]) {
			for (const deliveryId of ['a', 'b']) {
				expect((await session.callPluginMethod('user-chat.sendMessage', { deliveryId, content: 'Same' })).ok).toBe(true)
			}
			expect(await session.getEventsByType('user_chat_message_received')).toHaveLength(2)
		}
	})

	it('retains the oldest receipt after 1,000 later deliveries and replay', async () => {
		const owner = harness()
		const { session, agentId } = await paused(owner)
		const input = { deliveryId: 'oldest', content: 'Original' }
		const first = await session.callPluginMethod('user-chat.sendMessage', input)
		expect(first.ok).toBe(true)
		for (let i = 0; i < 1000; i++) {
			expect((await session.callPluginMethod('user-chat.sendMessage', {
				deliveryId: `later-${i}`, content: 'Later', ...(i % 2 ? { agentId } : {}),
			})).ok).toBe(true)
		}
		const verify = async (current: typeof session) => {
			expect(await current.callPluginMethod('user-chat.sendMessage', input)).toEqual(first)
			expect(await current.callPluginMethod('user-chat.sendMessage', { ...input, content: 'Changed' })).toMatchObject({
				ok: false, error: { type: 'user_chat_delivery_conflict' },
			})
			expect(await current.getEventsByType('user_chat_message_received')).toHaveLength(1001)
		}
		await verify(session)
		await owner.shutdown()
		await verify(await harness(owner.eventStore).openSession(session.sessionId))
	})

	it.each([
		['hello', ' hello'],
		['hello', 'hello\n'],
		['é', 'e\u0301'],
		['a\u0000b', 'ab'],
		['x '.repeat(25_000) + 'A', 'x '.repeat(25_000) + 'B'],
	])('compares original content exactly (%#)', async (original, different) => {
		const { session } = await paused(harness())
		expect((await session.callPluginMethod('user-chat.sendMessage', { deliveryId: 'content', content: original })).ok).toBe(true)
		expect(await session.callPluginMethod('user-chat.sendMessage', { deliveryId: 'content', content: different })).toMatchObject({ ok: false, error: { type: 'user_chat_delivery_conflict' } })
		expect(await session.getEventsByType('user_chat_message_received')).toHaveLength(1)
	})

	it('rejects an empty delivery ID while legacy calls remain independent', async () => {
		const { session } = await paused(harness())
		expect(await session.callPluginMethod('user-chat.sendMessage', { deliveryId: '', content: 'Hello' })).toMatchObject({ ok: false, error: { type: 'validation_error' } })
		await session.callPluginMethod('user-chat.sendMessage', { content: 'Hello' })
		await session.callPluginMethod('user-chat.sendMessage', { content: 'Hello' })
		const events = await session.getEventsByType('user_chat_message_received')
		expect(events).toHaveLength(2)
		for (const event of events) expect(event).not.toHaveProperty('delivery')
	})

	it('does not rewrite full-content files when a long delivery is replayed', async () => {
		const { session } = await paused(harness())
		const write = spyOn(SessionFileStore.prototype, 'write')
		try {
			const input = { deliveryId: 'long', content: 'word '.repeat(25_000) }
			const first = await session.callPluginMethod('user-chat.sendMessage', input)
			expect(first.ok).toBe(true)
			expect(write).toHaveBeenCalledTimes(1)
			expect(await session.callPluginMethod('user-chat.sendMessage', input)).toEqual(first)
			expect(write).toHaveBeenCalledTimes(1)
			const events = await session.getEventsByType('user_chat_message_received')
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ content: expect.stringContaining('Full message saved to:') })
		} finally {
			write.mockRestore()
		}
	})

	it.each([false, true])('allows retry after definite failure (changed payload: %s)', async (changed) => {
		const store = new DeliveryStore()
		const { session } = await paused(harness(store))
		store.failure = 'definite'
		const input = { deliveryId: 'retry', content: 'Original' }
		await expect(session.callPluginMethod('user-chat.sendMessage', input)).rejects.toBeInstanceOf(EventAppendError)
		expect(await session.getEventsByType('user_chat_message_received')).toHaveLength(0)
		expect((await session.callPluginMethod('user-chat.sendMessage', { ...input, content: changed ? 'Changed' : input.content })).ok).toBe(true)
		expect(await session.getEventsByType('user_chat_message_received')).toHaveLength(1)
	})

	it('retains receipts through answers, outbound messages, consumption and reload', async () => {
		const owner = harness()
		const { session, agentId } = await paused(owner)
		const input = { deliveryId: 'durable', content: 'Remember' }
		const original = await session.callPluginMethod('user-chat.sendMessage', input)
		await session.callPluginMethod('user-chat.askQuestion', { agentId, question: 'Why?', inputType: { type: 'text' } })
		await session.callPluginMethod('user-chat.answerQuestion', { agentId, questionId: 'm2', answer: 'Because' })
		await session.callPluginMethod('user-chat.tellUser', { agentId, message: 'Done', format: 'text' })
		await session.resumeAgent(agentId)
		await session.waitForIdle()
		expect(selectPluginState<UserChatState>(session.state, 'messages')?.pendingInbound).toHaveLength(0)
		expect(await session.callPluginMethod('user-chat.sendMessage', input)).toEqual(original)
		await owner.shutdown()
		const fresh = await harness(owner.eventStore).openSession(session.sessionId)
		expect(await fresh.callPluginMethod('user-chat.sendMessage', input)).toEqual(original)
		expect(await fresh.getEventsByType('user_chat_message_received')).toHaveLength(1)
		expect(await fresh.callPluginMethod('user-chat.getMessages', { sessionId: session.sessionId })).not.toHaveProperty('value.acceptedDeliveries')
	})

	it('propagates unknown acceptance, fences retries, and replays the committed receipt after reload', async () => {
		const store = new DeliveryStore()
		const owner = harness(store)
		const { session } = await paused(owner)
		store.failure = 'unknown'
		const input = { deliveryId: 'unknown', content: 'Committed' }
		await expect(session.callPluginMethod('user-chat.sendMessage', input)).rejects.toBeInstanceOf(EventAppendOutcomeUnknownError)
		await expect(session.callPluginMethod('user-chat.sendMessage', input)).rejects.toThrow()
		expect(await session.getEventsByType('user_chat_message_received')).toHaveLength(1)
		await owner.shutdown()
		const fresh = await harness(store).openSession(session.sessionId)
		expect(await fresh.callPluginMethod('user-chat.sendMessage', input)).toEqual({ ok: true, value: { messageId: 'm1' } })
		expect(await fresh.getEventsByType('user_chat_message_received')).toHaveLength(1)
	})
})
