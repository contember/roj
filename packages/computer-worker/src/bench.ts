/**
 * Event-replay scaling benchmark.
 *
 * Session rehydration replays the whole event log through the composed plugin
 * reducers — pure CPU with no network, so `wrangler dev` wall time is a usable
 * proxy for the CPU time a deployed isolate would burn.
 *
 * Events are written straight to the EventStore rather than driven through
 * agents: the question is how replay scales with log length, not how fast
 * agents produce events.
 */

import { agentEvents, applyEvent, createSystemFromServices, reconstructSessionState } from '@roj-ai/sdk'
import type { AgentId, DomainEvent, LLMMessage, Services, SessionId } from '@roj-ai/sdk'

/** Events per synthetic turn — mirrors the shape of one real inference turn. */
const EVENTS_PER_TURN = 5

/** Seeding uses batches so the run stays tractable; single appends are probed separately. */
const SEED_BATCH_SIZE = 100

/** Single appends measured at full log size — exposes any per-append cost that grows with the file. */
const SINGLE_APPEND_PROBE = 10

/** Events written by createSession + the close/reopen cleanup below. */
const HEADER_EVENTS = 4

const USER_TEXT = 'Please continue with the refactor and report what changed in the module you just touched.'

const ASSISTANT_TEXT = 'I moved the retry policy out of the request loop and into a dedicated helper so the backoff '
	+ 'state is no longer recreated on every attempt. The call site now passes an explicit deadline instead of '
	+ 'relying on the ambient timeout, which also removes the last reference to the module-level mutable clock. '
	+ 'Tests still pass; I left the deprecated export in place for one more release.'

export interface BenchRow {
	/** Events in the log at the moment replay was measured. */
	events: number
	/** What the store holds for this session — JSONL bytes, or event-row payload bytes. */
	storedBytes: number
	appendBatchMs: number
	appendBatchPerEventMs: number
	appendSingleMs: number
	appendSinglePerEventMs: number
	/** `EventStore.load` alone — read + JSON.parse + zod validate, no reducers. */
	eventStoreLoadMs: number
	/** `loadRange` for the last 10 events — what a poller asks for on every tick. */
	tailRangeMs: number
	/** Reduce over the core + mailbox reducer only, no plugin slices. */
	coreReplayMs: number
	/** Full `SessionManager.getSession` on a manager that has never seen this session. */
	coldGetSessionMs: number
	/** Second `getSession` on the same manager — cache hit. */
	warmGetSessionMs: number
}

export interface BenchResult {
	/** Which EventStore backed the run. */
	store: string
	rows: BenchRow[]
	totalMs: number
	notes: string[]
}

export interface BenchOptions {
	/** The store under test is whatever `services.eventStore` is. */
	services: Services<'isolate'>
	store: string
	storedBytes: (sessionId: SessionId) => Promise<number>
	presetId: string
	counts: readonly number[]
}

/** workerd freezes the clock between I/O, so a timer yield is needed before reading it. */
async function now(): Promise<number> {
	await scheduler.wait(0)
	return Date.now()
}

async function timed<T>(fn: () => Promise<T> | T): Promise<{ value: T; ms: number }> {
	const start = await now()
	const value = await fn()
	return { value, ms: (await now()) - start }
}

function withSession<T extends object>(sessionId: SessionId, event: T): T & { sessionId: SessionId } {
	return Object.assign(event, { sessionId })
}

/**
 * One synthetic turn.
 *
 * `agent_conversation_spliced` stands in for `inference_completed`: the SDK
 * exports no factory for `llmEvents` / `toolEvents` / `sessionEvents`, and the
 * two events cost the same to replay — a `state` spread, an `agents` Map copy
 * and a full `conversationHistory` array copy carrying the message payload.
 */
function* syntheticTurns(sessionId: SessionId, agentId: AgentId): Generator<DomainEvent> {
	let historyLength = 0
	for (let turn = 1;; turn++) {
		const insert: LLMMessage[] = [
			{ role: 'user', content: `${USER_TEXT} (turn ${turn})`, sourceMessageIds: [] },
			{ role: 'assistant', content: `${ASSISTANT_TEXT} (turn ${turn})` },
		]
		yield withSession(sessionId, agentEvents.create('agent_state_changed', { agentId, fromState: 'pending', toState: 'inferring' }))
		yield withSession(sessionId, agentEvents.create('handler_started', { agentId, handlerName: 'beforeInference' }))
		yield withSession(sessionId, agentEvents.create('handler_completed', { agentId, handlerName: 'beforeInference', result: null }))
		yield withSession(sessionId, agentEvents.create('agent_conversation_spliced', { agentId, start: historyLength, deleteCount: 0, insert }))
		yield withSession(sessionId, agentEvents.create('agent_state_changed', { agentId, fromState: 'inferring', toState: 'pending' }))
		historyLength += insert.length
	}
}

function take(events: Generator<DomainEvent>, count: number): DomainEvent[] {
	const batch: DomainEvent[] = []
	for (let i = 0; i < count; i++) {
		const next = events.next()
		if (next.done) break
		batch.push(next.value)
	}
	return batch
}

export async function runBench(options: BenchOptions): Promise<BenchResult> {
	const { services, store, storedBytes, presetId, counts } = options
	const startedAt = await now()
	const rows: BenchRow[] = []

	for (const target of counts) {
		const syntheticCount = target - HEADER_EVENTS - SINGLE_APPEND_PROBE
		if (syntheticCount < EVENTS_PER_TURN) {
			throw new Error(`count ${target} is below the ${HEADER_EVENTS + SINGLE_APPEND_PROBE + EVENTS_PER_TURN} event floor`)
		}

		const seedSystem = createSystemFromServices(services)
		const created = await seedSystem.sessionManager.createSession(presetId)
		if (!created.ok) throw new Error(`createSession failed: ${JSON.stringify(created.error)}`)
		const seed = created.value
		const sessionId = seed.id
		const agentId = seed.getEntryAgentId()
		if (!agentId) throw new Error('session has no entry agent')

		// close() drops the live Session createSession leaves behind, and reopen() puts
		// the log back in the active state replay needs. Kept as the committed numbers
		// were measured, so the two stores stay comparable with them.
		await seed.close()
		await scheduler.wait(0)
		await seed.reopen()

		const events = syntheticTurns(sessionId, agentId)

		const appendBatch = await timed(async () => {
			for (let done = 0; done < syntheticCount; done += SEED_BATCH_SIZE) {
				await services.eventStore.appendBatch(sessionId, take(events, Math.min(SEED_BATCH_SIZE, syntheticCount - done)))
			}
		})

		const appendSingle = await timed(async () => {
			for (let i = 0; i < SINGLE_APPEND_PROBE; i++) {
				await services.eventStore.append(sessionId, take(events, 1)[0])
			}
		})

		const bytes = await storedBytes(sessionId)
		const loaded = await timed(() => services.eventStore.load(sessionId))
		const tailRange = await timed(() => services.eventStore.loadRange(sessionId, { since: loaded.value.length - 11 }))
		const coreReplay = await timed(() => reconstructSessionState(loaded.value, applyEvent))

		const benchSystem = createSystemFromServices(services)
		const cold = await timed(() => benchSystem.sessionManager.getSession(sessionId))
		const warm = await timed(() => benchSystem.sessionManager.getSession(sessionId))
		if (!cold.value.ok) throw new Error(`getSession failed: ${JSON.stringify(cold.value.error)}`)

		// Drop the session this load left live before moving to the next size.
		await cold.value.value.close()
		await scheduler.wait(0)

		rows.push({
			events: loaded.value.length,
			storedBytes: bytes,
			appendBatchMs: appendBatch.ms,
			appendBatchPerEventMs: appendBatch.ms / syntheticCount,
			appendSingleMs: appendSingle.ms,
			appendSinglePerEventMs: appendSingle.ms / SINGLE_APPEND_PROBE,
			eventStoreLoadMs: loaded.ms,
			tailRangeMs: tailRange.ms,
			coreReplayMs: coreReplay.ms,
			coldGetSessionMs: cold.ms,
			warmGetSessionMs: warm.ms,
		})
	}

	return {
		store,
		rows,
		totalMs: (await now()) - startedAt,
		notes: [
			`each turn is ${EVENTS_PER_TURN} events; agent_conversation_spliced stands in for inference_completed (no exported llmEvents factory)`,
			`seeding uses appendBatch(${SEED_BATCH_SIZE}); appendSingle* is ${SINGLE_APPEND_PROBE} single appends at full log size`,
			'tailRangeMs reads the last 10 events; every timing includes ~1ms of scheduler overhead, so read it as a ceiling',
			'coreReplayMs uses the core + mailbox reducer only — getSession composes ~14 more plugin slices',
			'loadSession calls EventStore.load twice (once to read the presetId, once inside SessionStore.load)',
			'every timing brackets a scheduler.wait(0) so workerd advances its clock; that adds ~1ms per measurement',
		],
	}
}
