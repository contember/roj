import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod/v4'
import { FileEventStore } from '~/core/events/file.js'
import { EventAppendError, SessionOwnershipLostError, EventAppendOutcomeUnknownError, type EventStore } from '~/core/events/event-store.js'
import { MemoryEventStore } from '~/core/events/memory.js'
import { createEventsFactory, type DomainEvent } from '~/core/events/types.js'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import { MockLLMProvider, type MockInferenceHandler } from '~/core/llm/mock.js'
import type { InferenceContext, InferenceRequest, InferenceResponse } from '~/core/llm/provider.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { SessionRuntimeUnavailableError } from '~/core/sessions/runtime-activity.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { SessionManager } from '~/core/sessions/session-manager.js'
import type { Session } from '~/core/sessions/session.js'
import { createTool } from '~/core/tools/definition.js'
import { ToolExecutor } from '~/core/tools/executor.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { agentWakeKey } from '~/core/wake-key.js'
import { silentLogger } from '~/lib/logger/logger.js'
import { Ok } from '~/lib/utils/result.js'
import type { Platform, Scheduler } from '~/platform/index.js'
import type { FileSystem } from '~/platform/fs.js'
import { agentStatusPlugin } from '~/plugins/agent-status/plugin.js'
import { agentsPlugin } from '~/plugins/agents/plugin.js'
import { mailboxPlugin } from '~/plugins/mailbox/plugin.js'
import { presetsPlugin, sessionLifecyclePlugin } from '~/plugins/session-lifecycle/index.js'
import { userChatPlugin, type UserChatState } from '~/plugins/user-chat/plugin.js'
import { chatMessageIdSchema } from '~/plugins/user-chat/schema.js'
import { createNodePlatform } from './node-platform.js'
import { createTestPreset } from './preset-helpers.js'

class RetainedScheduler implements Scheduler {
	readonly pending = new Map<string, number>()
	owner?: SessionManager
	transfer(owner: SessionManager): void { this.owner = owner }
	async wake(key: string, delayMs: number): Promise<void> { this.pending.set(key, delayMs) }
	async cancel(key: string): Promise<void> { this.pending.delete(key) }
	async deliver(manager: SessionManager, key: string): Promise<void> {
		if (!this.owner) throw new Error('Scheduler ownership not assigned')
		expect(manager).toBe(this.owner)
		expect(this.pending.has(key)).toBe(true)
		this.pending.delete(key)
		await manager.dispatchWake(key)
	}
}

class ContextMock extends MockLLMProvider {
	context?: InferenceContext
	override inference(request: InferenceRequest, context?: InferenceContext) {
		this.context = context
		return super.inference(request)
	}
}

class EpochBacking extends MemoryEventStore {
	private epoch = 1
	transfer(id: SessionId): Promise<void> {
		return this.serialize(id, async () => { this.epoch++ })
	}
	commit(id: SessionId, epoch: number, events: DomainEvent[]): Promise<void> {
		return this.serialize(id, async () => {
			if (epoch !== this.epoch) throw new SessionOwnershipLostError(id, new Error('Stale host epoch'))
			await super.doAppendBatch(id, events)
		})
	}
	adapter(epoch: number, beforeCommit?: () => Promise<void>): EventStore {
		const appendBatch = async (id: SessionId, events: DomainEvent[]) => {
			await beforeCommit?.()
			await this.commit(id, epoch, events)
		}
		return {
			append: (id, event) => appendBatch(id, [event]), appendBatch,
			load: (id) => this.load(id), exists: (id) => this.exists(id),
			listSessions: () => this.listSessions(), getMetadata: (id) => this.getMetadata(id),
			updateMetadata: (id, update) => this.updateMetadata(id, update),
			listSessionsWithMetadata: (options) => this.listSessionsWithMetadata(options),
			loadRange: (id, options) => this.loadRange(id, options),
			reconcileMetadata: (id, events) => this.reconcileMetadata(id, events),
		}
	}
}

const markers = createEventsFactory({ events: { host_marker: z.object({ value: z.string() }) } })
const directories: string[] = []
const managers: SessionManager[] = []
const releases: Array<() => void> = []
const tasks: Array<Promise<unknown>> = []

function track<T>(task: Promise<T>): Promise<T> {
	tasks.push(task.catch((error: unknown) => error))
	return task
}

function gate() {
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	releases.push(() => release.resolve())
	return { entered, release }
}

function response(tools = false): InferenceResponse {
	return {
		content: tools ? null : 'done',
		toolCalls: tools ? [
			{ id: ToolCallId('original-first'), name: 'record', input: { value: 'first' } },
			{ id: ToolCallId('original-second'), name: 'record', input: { value: 'second' } },
		] : [],
		finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics(),
	}
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), 'roj-session-host-'))
	directories.push(directory)
	return { directory, scheduler: new RetainedScheduler() }
}

function host(f: Awaited<ReturnType<typeof fixture>>, options: {
	provider?: MockInferenceHandler
	tool?: (value: string) => Promise<void>
	fs?: FileSystem
	eventStore?: EventStore
} = {}) {
	const platform: Platform = { ...createNodePlatform(), scheduler: f.scheduler }
	const eventStore = options.eventStore ?? new FileEventStore(f.directory, options.fs ?? platform.fs)
	const executions: string[] = []
	const plugin = definePlugin('host-test')
		.events([markers])
		.method('mark', {
			input: z.object({ value: z.string() }), output: z.object({}),
			handler: async (ctx, input) => {
				await ctx.emitEvent(markers.create('host_marker', input))
				return Ok({})
			},
		})
		.tools((ctx) => [createTool({
			name: 'record', description: 'Record a handoff test value', input: z.object({ value: z.string() }),
			execute: async (input) => {
				executions.push(input.value)
				await options.tool?.(input.value)
				await ctx.self.mark(input)
				return Ok(input.value)
			},
		})]).build()
	const provider = new ContextMock(options.provider ?? (() => response()))
	const manager = new SessionManager({
		eventStore, llmProvider: provider, toolExecutor: new ToolExecutor(silentLogger),
		presets: new Map([['test', createTestPreset()]]), logger: silentLogger,
		basePath: f.directory,
		dataFileStore: new SessionFileStore(f.directory, undefined, false, platform.fs, 'session'),
		platform,
		systemPlugins: [sessionLifecyclePlugin, presetsPlugin, mailboxPlugin, agentsPlugin, agentStatusPlugin, userChatPlugin, plugin],
	})
	managers.push(manager)
	if (!f.scheduler.owner) f.scheduler.transfer(manager)
	return { manager, eventStore, provider, executions }
}

type Host = ReturnType<typeof host>

async function create(h: Host) {
	const result = await h.manager.createSession('test')
	if (!result.ok) throw new Error(result.error.message)
	return result.value
}

function activate(h: Host, id: SessionId) {
	const result = h.manager.activateSession(id)
	if (!result.ok) throw new Error(result.error.message)
	return result.value
}

async function load(h: Host, id: SessionId) {
	activate(h, id)
	const result = await h.manager.getSession(id)
	if (!result.ok) throw new Error(result.error.message)
	return result.value
}

function key(session: Session) {
	const id = session.getEntryAgentId()
	if (!id) throw new Error('Entry agent missing')
	return agentWakeKey(session.id, id, 'debounce')
}

async function send(session: Session, deliveryId: string, content = 'handoff input') {
	const result = await session.callPluginMethod('user-chat.sendMessage', { deliveryId, content })
	if (!result.ok) throw new Error(result.error.message)
	return z.object({ messageId: chatMessageIdSchema }).parse(result.value).messageId
}

afterEach(async () => {
	for (const release of releases.splice(0)) release()
	await Promise.all(tasks.splice(0))
	for (const manager of managers.splice(0)) await manager.shutdown()
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('cross-host file-backed handoff', () => {
	it('retains the real wake across park, refuses implicit reload on A, and consumes d1 once on B', async () => {
		const f = await fixture()
		const a = host(f)
		const session = await create(a)
		const messageId = await send(session, 'd1')
		const wake = key(session)
		const retained = [...f.scheduler.pending]
		expect(retained.some(([entry]) => entry === wake)).toBe(true)
		expect(a.provider.getCallCount()).toBe(0)
		await a.manager.parkSession(activate(a, session.id))
		expect([...f.scheduler.pending]).toEqual(retained)
		expect((await a.eventStore.load(session.id)).filter((event) => event.type === 'session_closed')).toEqual([])
		const refused = await a.manager.getSession(session.id)
		expect(refused.ok).toBe(false)
		if (!refused.ok) expect(refused.error.type).toBe('session_runtime_unavailable')
		await expect(a.manager.dispatchWake(wake)).rejects.toBeInstanceOf(SessionRuntimeUnavailableError)
		expect(a.manager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
		// Ownership transfers only after A has drained; B has no in-memory session or store cache.
		const b = host(f)
		f.scheduler.transfer(b.manager)
		activate(b, session.id)
		await f.scheduler.deliver(b.manager, wake)
		const reopened = await load(b, session.id)
		await reopened.getEntryAgent()?.waitForIdle()
		expect(b.provider.getCallCount()).toBe(1)
		expect(JSON.stringify(b.provider.getLastRequest()?.messages)).toContain('handoff input')
		const consumed = z.array(z.object({ messageIds: z.array(z.string()) })).parse((await b.eventStore.load(session.id)).filter((event) => event.type === 'user_chat_messages_consumed'))
		expect(consumed.flatMap((event) => event.messageIds)).toEqual([messageId])
		await b.manager.dispatchWake(wake)
		expect(b.provider.getCallCount()).toBe(1)
	})

	it('persists consumed receipts and serializes concurrent replay and fresh acceptance after reload', async () => {
		const f = await fixture()
		const a = host(f)
		const session = await create(a)
		const original = await send(session, 'd1')
		await f.scheduler.deliver(a.manager, key(session))
		await a.manager.parkSession(activate(a, session.id))
		const b = host(f)
		f.scheduler.transfer(b.manager)
		const reopened = await load(b, session.id)
		const before = await b.eventStore.load(session.id)
		expect(await Promise.all([send(reopened, 'd1'), send(reopened, 'd1')])).toEqual([original, original])
		expect(await b.eventStore.load(session.id)).toEqual(before)
		expect(selectPluginState<UserChatState>(reopened.state, 'messages')?.pendingInbound).toEqual([])
		expect(f.scheduler.pending.size).toBe(0)
		expect(b.provider.getCallCount()).toBe(0)
		const conflict = await reopened.callPluginMethod('user-chat.sendMessage', { deliveryId: 'd1', content: 'changed' })
		expect(conflict.ok).toBe(false)
		if (!conflict.ok) expect(conflict.error.type).toBe('user_chat_delivery_conflict')
		const fresh = await Promise.all([send(reopened, 'd2', 'second input'), send(reopened, 'd2', 'second input')])
		expect(fresh[0]).toBe(fresh[1])
		expect(fresh[0]).not.toBe(original)
		expect(selectPluginState<UserChatState>(reopened.state, 'messages')?.pendingInbound.map((message) => message.messageId)).toEqual([fresh[0]])
		const received = z.array(z.object({ messageId: z.string() })).parse((await b.eventStore.load(session.id)).filter((event) => event.type === 'user_chat_message_received'))
		expect(received.map((event) => event.messageId)).toEqual([original, fresh[0]])
		await f.scheduler.deliver(b.manager, key(reopened))
		expect(b.provider.getCallCount()).toBe(1)
		const consumed = z.array(z.object({ messageIds: z.array(z.string()) })).parse((await b.eventStore.load(session.id)).filter((event) => event.type === 'user_chat_messages_consumed'))
		expect(consumed.flatMap((event) => event.messageIds)).toEqual([original, fresh[0]])
	})

	for (const boundary of ['inference', 'tool']) {
		it(`parks during ${boundary}, persists the boundary, and executes original remaining calls only on B`, async () => {
			const f = await fixture()
			const held = gate()
			const a = host(f, {
				provider: async () => {
					if (boundary === 'inference') { held.entered.resolve(); await held.release.promise }
					return response(true)
				},
				tool: async (value) => {
					if (boundary === 'tool' && value === 'first') { held.entered.resolve(); await held.release.promise }
				},
			})
			const session = await create(a)
			const tenure = activate(a, session.id)
			await send(session, 'd1')
			const processing = track(f.scheduler.deliver(a.manager, key(session)))
			await held.entered.promise
			let settled = false
			const parking = track(a.manager.parkSession(tenure).then(() => { settled = true }))
			expect((await session.callPluginMethod('host-test.mark', { value: 'external' })).ok).toBe(false)
			expect(settled).toBe(false)
			expect(a.provider.context?.signal?.aborted).toBe(false)
			held.release.resolve()
			await Promise.all([processing, parking])
			expect(a.provider.getCallCount()).toBe(1)
			expect(a.executions).toEqual(boundary === 'tool' ? ['first'] : [])
			const oldEvents = await a.eventStore.load(session.id)
			expect(oldEvents.filter((event) => event.type === 'inference_completed')).toHaveLength(1)
			expect(oldEvents.filter((event) => event.type === 'tool_completed')).toHaveLength(boundary === 'tool' ? 1 : 0)
			expect(z.array(z.object({ value: z.string() })).parse(oldEvents.filter((event) => event.type === 'host_marker')).map((event) => event.value)).toEqual(boundary === 'tool' ? ['first'] : [])
			const b = host(f)
			f.scheduler.transfer(b.manager)
			const reopened = await load(b, session.id)
			await reopened.getEntryAgent()?.waitForIdle()
			expect(b.executions).toEqual(boundary === 'tool' ? ['second'] : ['first', 'second'])
			const events = await b.eventStore.load(session.id)
			expect(z.array(z.object({ toolCallId: z.string() })).parse(events.filter((event) => event.type === 'tool_completed')).map((event) => event.toolCallId)).toEqual(['original-first', 'original-second'])
			expect(b.provider.getCallCount()).toBe(0)
			await f.scheduler.deliver(b.manager, key(reopened))
			expect(b.provider.getCallCount()).toBe(1)
			expect(JSON.stringify(b.provider.getLastRequest()?.messages)).toContain('original-first')
			expect(JSON.stringify(b.provider.getLastRequest()?.messages)).toContain('original-second')
			await b.manager.parkSession(activate(b, session.id))
			f.scheduler.transfer(a.manager)
			const fresh = activate(a, session.id)
			await a.manager.parkSession(tenure)
			a.manager.revokeSession(tenure)
			expect(activate(a, session.id)).toBe(fresh)
			expect((await load(a, session.id)).store.isDetached()).toBe(false)
		})
	}

	it('uses an adapter commit-time epoch fence to reject an issued old append after B commits', async () => {
		const f = await fixture()
		const held = gate()
		const backing = new EpochBacking()
		let hold = false
		const a = host(f, { eventStore: backing.adapter(1, async () => {
			if (hold) { held.entered.resolve(); await held.release.promise }
		}) })
		const session = await create(a)
		const tenure = activate(a, session.id)
		hold = true
		const oldAppend = track(session.callPluginMethod('host-test.mark', { value: 'old' }).catch((error: unknown) => error))
		await held.entered.promise
		// Epoch transfer and check+commit use the same backing-store serializer, not a preflight check.
		await backing.transfer(session.id)
		a.manager.revokeSession(tenure)
		const b = host(f, { eventStore: backing.adapter(2) })
		f.scheduler.transfer(b.manager)
		const reopened = await load(b, session.id)
		expect((await reopened.callPluginMethod('host-test.mark', { value: 'new' })).ok).toBe(true)
		held.release.resolve()
		expect(await oldAppend).toBeInstanceOf(EventAppendError)
		const events = await backing.load(session.id)
		expect(z.array(z.object({ value: z.string() })).parse(events.filter((event) => event.type === 'host_marker'))).toEqual([{ value: 'new' }])
	})

	it('stops a runtime whose write is refused because another host took the log', async () => {
		const f = await fixture()
		const backing = new EpochBacking()
		const a = host(f, { eventStore: backing.adapter(1) })
		const session = await create(a)
		activate(a, session.id)

		// B takes the log. A has no way to be told: nobody can revoke a host that is
		// merely unreachable, so it has to learn from its own refused write.
		await backing.transfer(session.id)
		await expect(session.callPluginMethod('host-test.mark', { value: 'late' }))
			.rejects.toBeInstanceOf(SessionOwnershipLostError)

		// The runtime stopped itself rather than retrying, and residency is gone, so a
		// later access reloads and asks the store who owns the log now.
		expect(a.manager.getRuntimeCacheStats().loadedSessionCount).toBe(0)
		const b = host(f, { eventStore: backing.adapter(2) })
		const reopened = await load(b, session.id)
		expect((await reopened.callPluginMethod('host-test.mark', { value: 'new' })).ok).toBe(true)
		const events = await backing.load(session.id)
		expect(z.array(z.object({ value: z.string() })).parse(events.filter((event) => event.type === 'host_marker'))).toEqual([{ value: 'new' }])
	})

	it('revokes inference synchronously and discards a noncooperative provider result without executing tools', async () => {
		const f = await fixture()
		const held = gate()
		const a = host(f, { provider: async () => {
			held.entered.resolve()
			await held.release.promise
			return response(true)
		} })
		const session = await create(a)
		const tenure = activate(a, session.id)
		await send(session, 'd1')
		const processing = track(f.scheduler.deliver(a.manager, key(session)).catch((error: unknown) => error))
		await held.entered.promise
		a.manager.revokeSession(tenure)
		expect(a.provider.context?.signal?.aborted).toBe(true)
		expect((await session.callPluginMethod('host-test.mark', { value: 'revoked' })).ok).toBe(false)
		held.release.resolve()
		await processing
		const events = await a.eventStore.load(session.id)
		expect(events.filter((event) => event.type === 'inference_completed')).toEqual([])
		expect(events.filter((event) => event.type === 'tool_completed')).toEqual([])
		expect(a.executions).toEqual([])
	})

	for (const committed of [false, true]) {
		it(`recovers inbound delivery after ${committed ? 'committed rename with failed readback' : 'pending write before failed rename'} using the log rather than metadata`, async () => {
			const f = await fixture()
			const fs = createNodePlatform().fs
			const rename = fs.rename
			if (!rename) throw new Error('Node platform requires rename')
			let armed = false
			let blockedPath: string | undefined
			let pendingPath: string | undefined
			function readFile(path: string): Promise<Buffer>
			function readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>
			function readFile(path: string, encoding?: 'utf-8' | 'utf8'): Promise<Buffer | string> {
				if (path === blockedPath) return Promise.reject(new Error('Injected readback unavailable'))
				return encoding === undefined ? fs.readFile(path) : fs.readFile(path, encoding)
			}
			const faultFs: FileSystem = {
				...fs, readFile,
				rename: async (source, target) => {
					if (armed && target.includes(`${join('.events', 'batches')}/`)) {
						armed = false
						pendingPath = source
						if (committed) { await rename(source, target); blockedPath = target }
						throw new Error('Injected rename response failure')
					}
					await rename(source, target)
				},
			}
			const a = host(f, { fs: faultFs })
			const session = await create(a)
			const tenure = activate(a, session.id)
			armed = true
			const failed = await session.callPluginMethod('user-chat.sendMessage', { deliveryId: 'd1', content: 'fault input' }).catch((error: unknown) => error)
			expect(failed).toBeInstanceOf(committed ? EventAppendOutcomeUnknownError : EventAppendError)
			expect(pendingPath).toBeDefined()
			if (!pendingPath) throw new Error('Fault did not hit an event batch')
			expect(await fs.exists(pendingPath)).toBe(!committed)
			if (committed) {
				await expect(session.callPluginMethod('host-test.mark', { value: 'uncertain' })).rejects.toBeInstanceOf(EventAppendOutcomeUnknownError)
			}
			a.manager.revokeSession(tenure)
			if (!committed) await fs.unlink(join(f.directory, 'sessions', session.id, '.events', 'meta.json'))
			// This is an injected filesystem error, not evidence of process-kill or power-loss durability.
			const b = host(f)
			f.scheduler.transfer(b.manager)
			const before = await b.eventStore.load(session.id)
			const receipts = z.array(z.object({ messageId: z.string() })).parse(before.filter((event) => event.type === 'user_chat_message_received'))
			expect(receipts).toHaveLength(committed ? 1 : 0)
			const reopened = await load(b, session.id)
			const ids = await Promise.all([send(reopened, 'd1', 'fault input'), send(reopened, 'd1', 'fault input')])
			expect(ids[0]).toBe(ids[1])
			if (committed) expect(receipts[0]?.messageId).toBe(ids[0])
			await reopened.getEntryAgent()?.waitForIdle()
			if (f.scheduler.pending.has(key(reopened))) await f.scheduler.deliver(b.manager, key(reopened))
			await reopened.getEntryAgent()?.waitForIdle()
			const events = await b.eventStore.load(session.id)
			expect(events.filter((event) => event.type === 'user_chat_message_received')).toHaveLength(1)
			expect(z.array(z.object({ messageIds: z.array(z.string()) })).parse(events.filter((event) => event.type === 'user_chat_messages_consumed')).flatMap((event) => event.messageIds)).toEqual([ids[0]])
			expect(b.provider.getCallCount()).toBe(1)
			expect((await b.eventStore.getMetadata(session.id))?.metrics?.totalEvents).toBe(events.length)
		})
	}
})
