/**
 * Where a Worker isolate's memory ceiling lands, in roj's own units.
 *
 * `?dim=` picks one dimension per request:
 *
 * - `raw` — allocate until the allocator refuses. Answers first: until a
 *   ceiling is shown to exist here, every other number below is a statement
 *   about how long the run was allowed to take, not about memory.
 * - `events` — one session's event log, replayed cold after every step.
 * - `history` — one agent's conversationHistory, grown by fat splices.
 * - `sessions` — live sessions held open in one DO.
 *
 * Nothing here exposes a heap counter — `process.memoryUsage()` is a stub of
 * zeroes — and the ceiling is not catchable: V8 aborts the whole workerd
 * process. So every step is journalled into ctx.storage *before* it runs, and
 * the number a run died at is read off the *next* request's `previous`. The two
 * log-backed dimensions also resume off the log they already wrote.
 *
 * `?ballastMiB=` is how a run gets a production-sized budget: `wrangler dev`
 * enforces V8's heap limit, roughly ten times the 128 MB a deployed isolate
 * gets, so holding the difference is what makes a local number mean anything.
 */

import { AgentId, SessionId, agentEvents, createSystemFromServices } from '@roj-ai/sdk'
import type { DomainEvent, LLMMessage, Services, Session } from '@roj-ai/sdk'
import { withOwnScheduler } from '../own-scheduler.js'
import { isolatePreset } from '../preset.js'
import type { LimitProbe, LimitProbeContext } from './context.js'

const MIB = 1024 * 1024

/** Page stride — a zero page nothing ever touches may never be committed. */
const TOUCH_STRIDE = 4096

/** Events per append, matching the bench; fat payloads shrink it by bytes below. */
const SEED_BATCH = 100

/** Bytes one seeding append aims for, so a fat-message step cannot blow up in one INSERT. */
const SEED_BATCH_BYTES = 1024 * 1024

const JOURNAL_PREFIX = 'limits:memory:'

// ============================================================================
// Params
// ============================================================================

function int(params: URLSearchParams, name: string, fallback: number, min = 1): number {
	const raw = params.get(name)
	if (raw === null) return fallback
	const value = Number(raw)
	if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number >= ${min}`)
	return Math.floor(value)
}

function flag(params: URLSearchParams, name: string, fallback = false): boolean {
	const raw = params.get(name)
	if (raw === null) return fallback
	return raw !== '0' && raw !== 'false'
}

function describe(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** workerd freezes the clock between I/O, so a timer yield is needed before reading it. */
async function now(): Promise<number> {
	await scheduler.wait(0)
	return Date.now()
}

// ============================================================================
// Allocation
// ============================================================================

type RawKind = 'bytes' | 'string' | 'objects'

/** Chars one synthetic message carries in the `objects` shape. */
const OBJECT_CONTENT_CHARS = 200

function readKind(params: URLSearchParams): RawKind {
	const raw = params.get('kind') ?? 'bytes'
	if (raw === 'bytes' || raw === 'string' || raw === 'objects') return raw
	throw new Error(`kind must be bytes, string or objects (got '${raw}')`)
}

/**
 * One retained chunk of roughly `bytes`.
 *
 * `bytes` is an ArrayBuffer — external memory, which V8 accounts separately
 * from its heap. `string` and `objects` land on the JS heap instead, which is
 * where a session's events and conversation actually live, so the three can
 * disagree about where the ceiling is. Content is Latin-1, one byte per char in
 * V8, but only `objects` reliably costs what it says: a `repeat`ed string
 * nothing reads back has no measurable cost at all (see `heldMiB`).
 */
function allocate(kind: RawKind, bytes: number, touch: boolean): unknown {
	if (kind === 'string') return 'x'.repeat(bytes)
	if (kind === 'objects') {
		const count = Math.max(1, Math.floor(bytes / OBJECT_CONTENT_CHARS))
		const items: LLMMessage[] = []
		for (let i = 0; i < count; i++) {
			items.push({ role: 'assistant', content: `${i}`.padEnd(OBJECT_CONTENT_CHARS, 'x') })
		}
		return items
	}
	const buffer = new Uint8Array(bytes)
	if (touch) for (let offset = 0; offset < bytes; offset += TOUCH_STRIDE) buffer[offset] = 1
	return buffer
}

/** MiB of ballast per slice — small enough that the chunks stay ordinary objects. */
const BALLAST_SLICE_MIB = 8

/**
 * JS-heap ballast, held for the length of a run.
 *
 * `wrangler dev` enforces V8's own heap limit, an order of magnitude above the
 * 128 MB a deployed isolate gets, so a dimension that just grows until it dies
 * measures this box and not the platform. Ballast closes the gap: hold
 * `heapLimit - budget` and the workload runs against a budget the caller chose.
 *
 * Built out of message objects rather than one long string: a string nothing
 * ever reads costs nothing measurable here, while objects with distinct
 * contents are resident from the moment they are built.
 */
function ballast(miB: number): unknown[] {
	const slices: unknown[] = []
	for (let held = 0; held < miB; held += BALLAST_SLICE_MIB) {
		slices.push(allocate('objects', Math.min(BALLAST_SLICE_MIB, miB - held) * MIB, false))
	}
	return slices
}

/**
 * Nominal MiB the chunks carry, counted by reading into every one of them.
 *
 * The read is the point: an allocation whose contents nothing ever looks at is
 * one V8 is free not to make — a 1 GiB string built by `repeat` and never read
 * costs no measurable memory here — and a ballast that was never built is no
 * budget at all. Object overhead sits on top of what this counts.
 */
function heldMiB(chunks: readonly unknown[]): number {
	let bytes = 0
	for (const chunk of chunks) {
		if (typeof chunk === 'string') bytes += chunk.charCodeAt(chunk.length - 1) === 0 ? 0 : chunk.length
		else if (chunk instanceof Uint8Array) bytes += chunk[chunk.length - 1] === undefined ? 0 : chunk.byteLength
		else if (Array.isArray(chunk)) bytes += chunk.length * OBJECT_CONTENT_CHARS
	}
	return Math.round(bytes / MIB)
}

/**
 * What a single impossible request does, as opposed to cumulative pressure.
 *
 * The two are not the same failure: an allocation V8 can see is impossible
 * comes back as a catchable RangeError, while merely running out of heap does
 * not come back at all.
 */
function oversized(): Record<string, string> {
	const out: Record<string, string> = {}
	try {
		out.arrayBuffer = `no error, ${new Uint8Array(2 ** 40).byteLength} bytes`
	} catch (error) {
		out.arrayBuffer = describe(error)
	}
	try {
		out.string = `no error, ${'x'.repeat(2 ** 40).length} chars`
	} catch (error) {
		out.string = describe(error)
	}
	return out
}

// ============================================================================
// Journal — durable progress, so a kill still reports a number
// ============================================================================

interface Journal {
	dim: string
	params: string
	unit: string
	startedAt: number
	/** Last step the run got past. */
	reached: number
	/** Step the run was inside when this was written; above `reached` means it died there. */
	attempting: number
	/** What the run was doing at `attempting`. */
	phase: string
	finished: boolean
	outcome?: string
	/** Session the log-backed dimensions keep appending to across attempts. */
	sessionId?: string
	agentId?: string
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

function toJournal(value: unknown): Journal | null {
	if (typeof value !== 'object' || value === null) return null
	if (!('dim' in value && 'params' in value && 'unit' in value && 'phase' in value)) return null
	if (!('startedAt' in value && 'reached' in value && 'attempting' in value && 'finished' in value)) return null
	const { dim, params, unit, phase, startedAt, reached, attempting, finished } = value
	if (typeof dim !== 'string' || typeof params !== 'string' || typeof unit !== 'string' || typeof phase !== 'string') return null
	if (typeof startedAt !== 'number' || typeof reached !== 'number' || typeof attempting !== 'number') return null
	if (typeof finished !== 'boolean') return null
	const outcome = 'outcome' in value && typeof value.outcome === 'string' ? value.outcome : undefined
	const sessionId = 'sessionId' in value && typeof value.sessionId === 'string' ? value.sessionId : undefined
	const agentId = 'agentId' in value && typeof value.agentId === 'string' ? value.agentId : undefined
	return { dim, params, unit, phase, startedAt, reached, attempting, finished, outcome, sessionId, agentId }
}

interface Tracker {
	/** What the previous attempt at this dimension left behind — a corpse if `finished` is false. */
	previous: Journal | null
	/** Records the step about to run. Durable before the step can kill the isolate. */
	attempt: (step: number, phase: string) => Promise<void>
	/** Records the step as survived. */
	reach: (step: number) => Promise<void>
	remember: (sessionId: SessionId, agentId: AgentId) => Promise<void>
	finish: (outcome: string) => Promise<void>
}

async function openJournal(ctx: DurableObjectState, dim: string, unit: string, params: URLSearchParams): Promise<Tracker> {
	const key = `${JOURNAL_PREFIX}${dim}`
	const stored = await ctx.storage.get(key)
	const previous = typeof stored === 'string' ? toJournal(parseJson(stored)) : null
	const carry = flag(params, 'reset') ? null : previous
	const journal: Journal = {
		dim,
		unit,
		params: params.toString(),
		startedAt: Date.now(),
		reached: 0,
		attempting: 0,
		phase: 'start',
		finished: false,
		sessionId: carry?.sessionId,
		agentId: carry?.agentId,
	}
	// A resolved put() is not yet a durable one: the write lands at the next I/O
	// checkpoint, and an isolate V8 aborts never reaches one. The yield is the
	// checkpoint, and without it a killed run leaves nothing behind but its header.
	const save = async () => {
		await ctx.storage.put(key, JSON.stringify(journal))
		await scheduler.wait(0)
	}
	await save()
	return {
		previous,
		attempt: async (step, phase) => {
			journal.attempting = step
			journal.phase = phase
			await save()
		},
		reach: async (step) => {
			journal.reached = step
			await save()
		},
		remember: async (sessionId, agentId) => {
			journal.sessionId = String(sessionId)
			journal.agentId = String(agentId)
			await save()
		},
		finish: async (outcome) => {
			journal.finished = true
			journal.outcome = outcome
			await save()
		},
	}
}

// ============================================================================
// Synthetic log
// ============================================================================

const USER_TEXT = 'Please continue with the refactor and report what changed in the module you just touched.'

const ASSISTANT_TEXT = 'I moved the retry policy out of the request loop and into a dedicated helper so the backoff '
	+ 'state is no longer recreated on every attempt. The call site now passes an explicit deadline instead of '
	+ 'relying on the ambient timeout, which also removes the last reference to the module-level mutable clock.'

function withSession<T extends object>(sessionId: SessionId, event: T): T & { sessionId: SessionId } {
	return Object.assign(event, { sessionId })
}

/**
 * A turn's worth of events, in the two shapes the log-backed dimensions need.
 *
 * `turns` mirrors the bench: five events, of which one splices two ordinary
 * messages into conversationHistory. `messages` writes nothing but splices,
 * each carrying one message of `messageBytes`, so history grows far faster
 * than the log does.
 */
function* syntheticEvents(
	sessionId: SessionId,
	agentId: AgentId,
	shape: 'turns' | 'messages',
	messageBytes: number,
	startHistory: number,
): Generator<DomainEvent> {
	let historyLength = startHistory
	for (let turn = 1; ; turn++) {
		if (shape === 'messages') {
			const insert: LLMMessage[] = [{ role: 'assistant', content: `turn ${turn} `.padEnd(messageBytes, 'x') }]
			yield withSession(sessionId, agentEvents.create('agent_conversation_spliced', { agentId, start: historyLength, deleteCount: 0, insert }))
			historyLength += 1
			continue
		}
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

/** Payload bytes and row count the DO's own SQLite holds — for one session, or all of them. */
function storedBytes(ctx: DurableObjectState, sessionId: string | null): { rows: number; bytes: number } {
	const rows = sessionId === null
		? ctx.storage.sql
			.exec<{ rows: number; bytes: number | null }>('SELECT COUNT(*) AS rows, SUM(LENGTH(payload)) AS bytes FROM roj_events')
			.toArray()
		: ctx.storage.sql
			.exec<{ rows: number; bytes: number | null }>(
				'SELECT COUNT(*) AS rows, SUM(LENGTH(payload)) AS bytes FROM roj_events WHERE session_id = ?',
				sessionId,
			)
			.toArray()
	return { rows: rows[0]?.rows ?? 0, bytes: rows[0]?.bytes ?? 0 }
}

/**
 * The session the log-backed dimensions append to.
 *
 * Closed on purpose: `getSession` skips onSessionReady for a closed session, so
 * a replay per step does not leave a git-status interval behind, and does not
 * emit the session_restarted event a recovered active session would.
 */
async function openLogSession(
	services: Services<'isolate'>,
	journal: Tracker,
	reset: boolean,
): Promise<{ sessionId: SessionId; agentId: AgentId; created: boolean }> {
	const carried = reset ? null : await carriedSession(services, journal.previous)
	if (carried) return { ...carried, created: false }

	const system = createSystemFromServices(withOwnScheduler(services))
	const result = await system.sessionManager.createSession(isolatePreset.id)
	if (!result.ok) throw new Error(`createSession failed: ${JSON.stringify(result.error)}`)
	const session = result.value
	const agentId = session.getEntryAgentId()
	if (!agentId) throw new Error('session has no entry agent')
	await session.close()
	await journal.remember(session.id, agentId)
	return { sessionId: session.id, agentId, created: true }
}

/** The session a previous attempt left in the journal, if its log is still there. */
async function carriedSession(
	services: Services<'isolate'>,
	previous: Journal | null,
): Promise<{ sessionId: SessionId; agentId: AgentId } | null> {
	if (!previous?.sessionId || !previous.agentId) return null
	const sessionId = SessionId(previous.sessionId)
	if (!await services.eventStore.exists(sessionId)) return null
	return { sessionId, agentId: AgentId(previous.agentId) }
}

// ============================================================================
// Dimensions
// ============================================================================

interface RawResult {
	dim: 'raw'
	kind: RawKind
	chunkMiB: number
	touch: boolean
	ballastMiB: number
	/** MiB the isolate handed out and kept, counted by reading into it; ballast excluded. */
	heldMiB: number
	outcome: string
	refusedWith?: string
	elapsedMs: number
	oversized: Record<string, string>
	introspection: Record<string, string>
	previous: Journal | null
	notes: string[]
}

async function probeRaw(context: LimitProbeContext): Promise<RawResult> {
	const { ctx, params } = context
	const kind = readKind(params)
	const chunkMiB = int(params, 'chunkMiB', 4)
	const maxMiB = int(params, 'maxMiB', 4096)
	const touch = flag(params, 'touch', true)
	const budgetMs = int(params, 'budgetMs', 60_000)
	const journal = await openJournal(ctx, 'raw', 'MiB', params)
	const held = ballast(int(params, 'ballastMiB', 0, 0))

	const retained: unknown[] = []
	const steps = Math.max(1, Math.floor(maxMiB / chunkMiB))
	const startedAt = await now()
	let outcome = `held maxMiB=${maxMiB} without a refusal`
	let refusedWith: string | undefined

	for (let step = 1; step <= steps; step++) {
		await journal.attempt(step * chunkMiB, 'allocate')
		try {
			retained.push(allocate(kind, chunkMiB * MIB, touch))
		} catch (error) {
			refusedWith = describe(error)
			outcome = 'allocator refused'
			break
		}
		await journal.reach(step * chunkMiB)
		if (Date.now() - startedAt > budgetMs) {
			outcome = `budget: ${budgetMs} ms elapsed`
			break
		}
	}

	const elapsedMs = (await now()) - startedAt
	const kept = heldMiB(retained)
	const ballastMiB = heldMiB(held)
	retained.length = 0
	held.length = 0
	await journal.finish(outcome)

	return {
		dim: 'raw',
		kind,
		chunkMiB,
		touch,
		ballastMiB,
		heldMiB: kept,
		outcome,
		refusedWith,
		elapsedMs,
		oversized: oversized(),
		introspection: introspection(),
		previous: journal.previous,
		notes: [
			'heldMiB is what the allocator handed out, not resident bytes — no counter exists to read',
			'kind=bytes is external (ArrayBuffer) memory; kind=string and kind=objects are JS heap, which is where a session lives',
			'an outcome of budget or maxMiB found no ceiling, it only ran out of permission — raise maxMiB to find one',
			'the JS-heap ceiling is not catchable: V8 aborts the whole workerd process, so read the number off the next request\'s previous',
		],
	}
}

interface LogRow {
	events: number
	/** Messages in the replayed agent's conversationHistory. */
	historyMessages: number
	/** Payload bytes the event rows hold for this session — the honest in-isolate size proxy. */
	storedBytes: number
	seedMs: number
	loadMs: number
	replayMs: number
}

interface LogResult {
	dim: 'events' | 'history'
	sessionId: string
	freshSession: boolean
	ballastMiB: number
	rows: LogRow[]
	outcome: string
	failedAt?: { events: number; error: string }
	elapsedMs: number
	previous: Journal | null
	notes: string[]
}

/**
 * Grow one session's log, replaying it cold after every step.
 *
 * Replay is the memory-hungry half: `EventStore.load` materialises the whole
 * log as parsed objects before a single reducer runs, and the reconstructed
 * state holds the conversation again on top of that.
 */
async function probeLog(context: LimitProbeContext, dim: 'events' | 'history'): Promise<LogResult> {
	const { ctx, params, boot } = context
	const { services } = boot()
	const shape = dim === 'history' ? 'messages' : 'turns'
	const messageBytes = int(params, 'messageKiB', 16) * 1024
	const perStep = dim === 'history'
		? int(params, 'step', 256)
		: int(params, 'step', 5000)
	const maxEvents = int(params, 'max', 1_000_000)
	const budgetMs = int(params, 'budgetMs', 120_000)

	const journal = await openJournal(ctx, dim, 'events', params)
	const { sessionId, agentId, created } = await openLogSession(services, journal, flag(params, 'reset'))
	const held = ballast(int(params, 'ballastMiB', 0, 0))

	const startedAt = await now()
	const rows: LogRow[] = []
	let outcome = `max: stopped at ${maxEvents} events`
	let failedAt: { events: number; error: string } | undefined

	let total = storedBytes(ctx, String(sessionId)).rows
	// Splices already in the log decide where the next one starts.
	let history = countHistory(ctx, String(sessionId))
	const events = syntheticEvents(sessionId, agentId, shape, messageBytes, history)
	// Retained so the row describes a session the isolate is still holding, not one it dropped.
	let live: Session | null = null

	while (total < maxEvents) {
		const target = Math.min(total + perStep, maxEvents)
		await journal.attempt(target, 'seed')
		const batchSize = Math.max(1, Math.min(SEED_BATCH, Math.floor(SEED_BATCH_BYTES / Math.max(messageBytes, 1))))

		try {
			const seedStart = await now()
			for (let done = total; done < target; done += batchSize) {
				await services.eventStore.appendBatch(sessionId, take(events, Math.min(batchSize, target - done)))
			}
			const seedMs = (await now()) - seedStart

			await journal.attempt(target, 'replay')
			live = null
			const system = createSystemFromServices(withOwnScheduler(services))
			const loadStart = await now()
			// Only the count is kept: holding the array here would double the peak getSession pays.
			const loadedCount = (await services.eventStore.load(sessionId)).length
			const loadMs = (await now()) - loadStart
			const replayStart = await now()
			const session = await system.sessionManager.getSession(sessionId)
			const replayMs = (await now()) - replayStart
			if (!session.ok) throw new Error(`getSession failed: ${JSON.stringify(session.error)}`)
			live = session.value

			total = loadedCount
			history = live.getAgent(agentId)?.state?.conversationHistory.length ?? -1
			rows.push({
				events: total,
				historyMessages: history,
				storedBytes: storedBytes(ctx, String(sessionId)).bytes,
				seedMs,
				loadMs,
				replayMs,
			})
			await journal.reach(total)
		} catch (error) {
			failedAt = { events: target, error: describe(error) }
			outcome = 'threw'
			break
		}

		if (Date.now() - startedAt > budgetMs) {
			outcome = `budget: ${budgetMs} ms elapsed`
			break
		}
	}

	const elapsedMs = (await now()) - startedAt
	const ballastMiB = heldMiB(held)
	held.length = 0
	await journal.finish(outcome)
	return {
		dim,
		sessionId: String(sessionId),
		freshSession: created,
		ballastMiB,
		rows,
		outcome,
		failedAt,
		elapsedMs,
		previous: journal.previous,
		notes: [
			'the log session is closed, so each replay skips onSessionReady — no git-status interval per step',
			'seeding writes events straight to the EventStore; the shape mirrors one inference turn',
			're-request without ?reset=1 to keep growing the same log — that is how a killed run resumes',
			'the last row is the largest log this isolate replayed and kept; ?ballastMiB shrinks the budget it did that in',
			'ballastMiB counts nominal message content — run dim=raw&kind=objects to see how much of it this build holds, then subtract the budget you want',
			'timings are indicative only: a shared dev box, and every measurement brackets a scheduler yield',
		],
	}
}

/** Messages the replayed agent's history holds, read straight off the log's splices. */
function countHistory(ctx: DurableObjectState, sessionId: string): number {
	const rows = ctx.storage.sql
		.exec<{ inserted: number | null }>(
			`SELECT SUM(json_array_length(json_extract(payload, '$.insert'))) AS inserted
			 FROM roj_events WHERE session_id = ? AND json_extract(payload, '$.type') = 'agent_conversation_spliced'`,
			sessionId,
		)
		.toArray()
	return rows[0]?.inserted ?? 0
}

interface SessionRow {
	live: number
	/** Wall clock since the first session, so the cost of holding the earlier ones is visible. */
	elapsedMs: number
	/** Event rows the whole DO holds — every open session keeps writing. */
	storedBytes: number
}

interface SessionsResult {
	dim: 'sessions'
	live: number
	turns: boolean
	ballastMiB: number
	rows: SessionRow[]
	outcome: string
	failedAt?: { live: number; error: string }
	elapsedMs: number
	previous: Journal | null
	notes: string[]
}

/**
 * Live sessions one DO holds at once.
 *
 * Every open session keeps a Session, its agents, its plugin slices and — via
 * git-status — a 2 s interval, so this measures a steady-state cost, not a peak.
 */
async function probeSessions(context: LimitProbeContext): Promise<SessionsResult> {
	const { ctx, params, boot } = context
	const { system } = boot()
	const max = int(params, 'max', 200)
	const sample = int(params, 'sample', 10)
	const budgetMs = int(params, 'budgetMs', 120_000)
	const turns = flag(params, 'turn')

	const journal = await openJournal(ctx, 'sessions', 'sessions', params)
	const held = ballast(int(params, 'ballastMiB', 0, 0))
	const startedAt = await now()
	const rows: SessionRow[] = []
	const live: Session[] = []
	let outcome = `max: stopped at ${max} sessions`
	let failedAt: { live: number; error: string } | undefined

	while (live.length < max) {
		const target = live.length + 1
		await journal.attempt(target, 'createSession')
		try {
			const created = await system.sessionManager.createSession(isolatePreset.id)
			if (!created.ok) throw new Error(`createSession failed: ${JSON.stringify(created.error)}`)
			live.push(created.value)
			if (turns) {
				await journal.attempt(target, 'turn')
				await runTurn(created.value)
			}
			await journal.reach(target)
		} catch (error) {
			failedAt = { live: target, error: describe(error) }
			outcome = 'threw'
			break
		}

		if (live.length % sample === 0 || live.length === max) {
			rows.push({
				live: live.length,
				elapsedMs: (await now()) - startedAt,
				storedBytes: storedBytes(ctx, null).bytes,
			})
		}

		if (Date.now() - startedAt > budgetMs) {
			outcome = `budget: ${budgetMs} ms elapsed`
			break
		}
	}

	const elapsedMs = (await now()) - startedAt
	const ballastMiB = heldMiB(held)
	held.length = 0
	await journal.finish(outcome)
	return {
		dim: 'sessions',
		live: live.length,
		turns,
		ballastMiB,
		rows,
		outcome,
		failedAt,
		elapsedMs,
		previous: journal.previous,
		notes: [
			'sessions are left open on purpose — closing them is what the DO would have to do to reclaim anything',
			'git-status arms a 2 s interval per open session, so the per-step cost grows with the sessions already held: read elapsedMs per row, not just the total',
			'?turn=1 drives one scripted user-chat turn per session, which is what makes the agent state real',
			'?ballastMiB shrinks the budget the sessions are held in — see the dim=raw notes for calibrating it',
		],
	}
}

/** One scripted turn, so the session carries the state a real one would. */
async function runTurn(session: Session, timeoutMs = 20_000): Promise<void> {
	const agentId = session.getEntryAgentId()
	if (!agentId) throw new Error('session has no entry agent')
	const sent = await session.callPluginMethod('user-chat.sendMessage', {
		sessionId: String(session.id),
		content: 'Please write a note file.',
		agentId: String(agentId),
	})
	if (!sent.ok) throw new Error(`sendMessage failed: ${JSON.stringify(sent.error)}`)

	const idle = () => {
		for (const [id] of session.state.agents) {
			const agent = session.getAgent(id)
			const state = agent?.state
			if (!agent || !state) continue
			if (state.status !== 'pending' || state.pendingToolCalls.length > 0 || state.pendingToolResults.length > 0 || agent.isScheduled()) {
				return false
			}
		}
		return true
	}
	// A timeout is not fatal here: a session still mid-turn is a heavier session,
	// which is the conservative direction for a memory measurement.
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (idle()) return
		await scheduler.wait(20)
	}
}

// ============================================================================
// Introspection
// ============================================================================

/** Nothing here exposes a heap counter; recorded so the ballast detour's necessity is on the record. */
function introspection(): Record<string, string> {
	const out: Record<string, string> = {}
	const perf: unknown = performance
	out['performance.memory'] = typeof perf === 'object' && perf !== null && 'memory' in perf ? 'present' : 'absent'
	const global: unknown = globalThis
	const proc: unknown = typeof global === 'object' && global !== null && 'process' in global ? global.process : undefined
	if (typeof proc !== 'object' || proc === null || !('memoryUsage' in proc)) {
		out['process.memoryUsage'] = 'absent'
		return out
	}
	const fn: unknown = proc.memoryUsage
	if (typeof fn !== 'function') {
		out['process.memoryUsage'] = 'absent'
		return out
	}
	try {
		const usage: unknown = fn.call(proc)
		out['process.memoryUsage'] = JSON.stringify(usage)
	} catch (error) {
		out['process.memoryUsage'] = `threw ${describe(error)}`
	}
	return out
}

// ============================================================================
// Entry point
// ============================================================================

const DIMENSIONS = ['raw', 'events', 'history', 'sessions'] as const

export const memoryProbe: LimitProbe = async (context) => {
	const dim = context.params.get('dim') ?? 'raw'
	if (dim === 'raw') return probeRaw(context)
	if (dim === 'events' || dim === 'history') return probeLog(context, dim)
	if (dim === 'sessions') return probeSessions(context)
	return { error: `unknown dim '${dim}'`, dims: DIMENSIONS }
}
