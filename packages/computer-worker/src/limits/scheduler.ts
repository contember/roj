/**
 * Whether a turn continues across a DO alarm with nothing in memory to carry it.
 *
 * `lifecycle` asked whether the agent loop survives a request returning; timers
 * answered yes, on a CPU budget nothing refills. This asks the question the
 * scheduler port exists for: does the next hop of a turn happen when the isolate
 * has forgotten the session entirely — no SessionManager, no Agent, no timer —
 * and all that is left is a row in the DO's KV and its one alarm slot?
 *
 * `?phase=` runs one half, or both:
 *
 * - `start` — send the opening message, then drop the booted SDK the way an
 *   eviction would, and return. What remains is a persisted wake and an armed alarm.
 * - `check` — read the event log and the written file straight off storage. It
 *   deliberately does not load the session: `loadSession` runs
 *   `checkPendingAgents()`, which would finish the turn itself and prove nothing.
 * - `run` — both, plus polling until the file lands. One command, one answer.
 * - `arm` / `wakes` — arm a bare wake with no session behind it, and read the alarm
 *   slot back. Restart the runtime between the two and what survived is only storage.
 *
 * Two controls make the design's two load-bearing choices falsifiable:
 * `?keepWakes=0` lets the teardown cancel the wakes it finds, and `?flush=0`
 * returns without settling the alarm write.
 */

import { SessionId } from '@roj-ai/sdk'
import type { DomainEvent, Services, Session } from '@roj-ai/sdk'
import { NOTE_PATH } from '../mock-llm.js'
import { isolatePreset } from '../preset.js'
import type { Booted, LimitProbe, LimitProbeContext } from './context.js'

const STATE_KEY = 'limits:scheduler:run'

/** The writer agent's output, under the session's own workspace directory. */
const NOTE_NAME = NOTE_PATH.split('/').pop() ?? 'note.md'

/** Set on first probe call, not at module scope — a change means the isolate restarted. */
let isolateId: string | undefined

function currentIsolate(): string {
	isolateId ??= crypto.randomUUID().slice(0, 8)
	return isolateId
}

/** workerd pins the clock between I/O, so yield before reading it. */
async function now(): Promise<number> {
	await scheduler.wait(0)
	return Date.now()
}

interface StartedRun {
	sessionId: string
	isolate: string
	startedAt: number
	/** Events already written when the starting request returned. */
	eventsAtReturn: number
	/** Whether a booted SDK was actually there to drop. */
	evicted: boolean
	/** Controls, echoed back so a result reads on its own. */
	keepWakes: boolean
	flushed: boolean
	/** Wakes persisted and unhandled at return — what has to carry the turn. */
	pendingWakes: number
	/** The DO's alarm slot as storage reports it, not as the scheduler remembers it. */
	alarmAt: number | null
	/** Alarms this isolate had served before the run started. */
	drainsAtReturn: number
}

function toStartedRun(value: unknown): StartedRun | null {
	if (typeof value !== 'object' || value === null) return null
	const record: Record<string, unknown> = { ...value }
	const { sessionId, isolate, startedAt, eventsAtReturn, pendingWakes, drainsAtReturn } = record
	if (typeof sessionId !== 'string' || typeof isolate !== 'string') return null
	if (typeof startedAt !== 'number' || typeof eventsAtReturn !== 'number') return null
	if (typeof pendingWakes !== 'number' || typeof drainsAtReturn !== 'number') return null
	return {
		sessionId,
		isolate,
		startedAt,
		eventsAtReturn,
		evicted: record.evicted === true,
		keepWakes: record.keepWakes === true,
		flushed: record.flushed === true,
		pendingWakes,
		alarmAt: typeof record.alarmAt === 'number' ? record.alarmAt : null,
		drainsAtReturn,
	}
}

async function countEvents(services: Services<'isolate'>, sessionId: string): Promise<number> {
	const events: DomainEvent[] = await services.eventStore.load(SessionId(sessionId))
	return events.length
}

/** Creates a session and sends the opening message, without waiting for the agents. */
async function startSession(booted: Booted, message: string): Promise<Session> {
	const created = await booted.system.sessionManager.createSession(isolatePreset.id)
	if (!created.ok) throw new Error(`createSession failed: ${JSON.stringify(created.error)}`)
	const session = created.value
	const entryAgentId = session.getEntryAgentId()
	if (!entryAgentId) throw new Error('preset has no entry agent')

	const sent = await session.callPluginMethod('user-chat.sendMessage', {
		sessionId: String(session.id),
		content: message,
		agentId: String(entryAgentId),
	})
	if (!sent.ok) throw new Error(`sendMessage failed: ${JSON.stringify(sent.error)}`)
	return session
}

/** The turn's visible outcome — the file the writer agent was asked for. */
async function readNote(context: LimitProbeContext, sessionId: string): Promise<string | null> {
	try {
		return await context.platform.fs.readFile(`/workspace/${sessionId}/${NOTE_NAME}`, 'utf-8')
	} catch {
		return null
	}
}

async function runStart(context: LimitProbeContext, message: string): Promise<StartedRun> {
	// Two controls, both off by default: `?keepWakes=0` lets the teardown cancel the
	// wakes it finds, and `?flush=0` returns without settling the alarm write.
	const keepWakes = context.params.get('keepWakes') !== '0'
	const flush = context.params.get('flush') !== '0'

	const booted = context.boot()
	const startedAt = await now()
	const session = await startSession(booted, message)
	const sessionId = String(session.id)
	const eventsAtReturn = await countEvents(booted.services, sessionId)

	// Everything needed to continue the turn is persisted by now, so throw the rest away.
	const evicted = await context.evictSdk(keepWakes)
	if (flush) await context.scheduler.flush()

	const run: StartedRun = {
		sessionId,
		isolate: currentIsolate(),
		startedAt,
		eventsAtReturn,
		evicted,
		keepWakes,
		flushed: flush,
		pendingWakes: context.scheduler.stats().pending,
		alarmAt: await context.ctx.storage.getAlarm(),
		drainsAtReturn: context.scheduler.stats().drains,
	}
	await context.ctx.storage.put(STATE_KEY, run)
	return run
}

async function report(context: LimitProbeContext, run: StartedRun, phase: string): Promise<unknown> {
	const events = await countEvents(context.boot().services, run.sessionId)
	return {
		phase,
		...run,
		isolateNow: currentIsolate(),
		isolateRestarted: currentIsolate() !== run.isolate,
		eventsNow: events,
		// The whole question: what happened with no session in memory and no request in flight?
		progressedAcrossAlarms: events - run.eventsAtReturn,
		alarmsSince: context.scheduler.stats().drains - run.drainsAtReturn,
		alarmArmedNow: await context.ctx.storage.getAlarm(),
		scheduler: context.scheduler.stats(),
		wakes: context.wakeLog(),
		note: await readNote(context, run.sessionId),
		elapsedMs: (await now()) - run.startedAt,
	}
}

async function runFull(context: LimitProbeContext, message: string, timeoutMs: number): Promise<unknown> {
	const run = await runStart(context, message)
	const deadline = run.startedAt + timeoutMs

	// Polling reads storage only — it never touches the session, so nothing here
	// can drive the loop. Every hop below is an alarm.
	let settledAtMs: number | null = null
	while ((await now()) < deadline) {
		if (await readNote(context, run.sessionId) !== null) {
			settledAtMs = (await now()) - run.startedAt
			break
		}
		await scheduler.wait(100)
	}

	// Let the last hop finish so the event count is the turn's, not a snapshot mid-flight.
	await scheduler.wait(1200)
	return { ...(await report(context, run, 'run') as Record<string, unknown>), settledAtMs }
}

/** What the alarm slot holds right now — the phase to call after restarting the runtime. */
async function runWakes(context: LimitProbeContext): Promise<Record<string, unknown>> {
	const alarmArmedNow = await context.ctx.storage.getAlarm()
	return {
		phase: 'wakes',
		isolateNow: currentIsolate(),
		alarmArmedNow,
		alarmInMs: alarmArmedNow === null ? null : alarmArmedNow - (await now()),
		scheduler: context.scheduler.stats(),
		wakes: context.wakeLog(),
	}
}

/**
 * Whether a request that polls in a tight loop still lets its alarm in.
 *
 * An alarm is delivered as an event, and a request spinning on short timers can
 * keep the isolate from taking one — which turns a debounce hop into a hang.
 */
async function runSpin(context: LimitProbeContext, armMs: number, spinMs: number, pollMs: number): Promise<unknown> {
	const before = context.scheduler.stats().drains
	await context.scheduler.wake('probe:spin', armMs)
	await context.scheduler.flush()

	const startedAt = await now()
	const armedAt = await context.ctx.storage.getAlarm()
	let elapsedMs = 0
	while (elapsedMs < spinMs) {
		await scheduler.wait(pollMs)
		elapsedMs = (await now()) - startedAt
	}

	return {
		phase: 'spin',
		armMs,
		spinMs,
		pollMs,
		armedAt,
		// Non-zero means the alarm got in while the request was spinning.
		drainsDuringSpin: context.scheduler.stats().drains - before,
		scheduler: context.scheduler.stats(),
		wakes: context.wakeLog(),
	}
}

export const schedulerProbe: LimitProbe = async (context) => {
	const phase = context.params.get('phase') ?? 'run'
	const message = context.params.get('message') ?? 'Please write a note file.'

	if (phase === 'spin') {
		return runSpin(
			context,
			Number(context.params.get('armMs') ?? 50),
			Number(context.params.get('spinMs') ?? 3000),
			Number(context.params.get('pollMs') ?? 1),
		)
	}

	if (phase === 'arm') {
		// A bare wake, no session behind it: dispatch is a no-op, so what it measures
		// is only the scheduler — that a row and an alarm outlive the process.
		const key = context.params.get('key') ?? 'probe:manual'
		const delayMs = Number(context.params.get('delayMs') ?? 20_000)
		await context.scheduler.wake(key, delayMs)
		await context.scheduler.flush()
		return { ...await runWakes(context), phase: 'arm', key, delayMs }
	}
	if (phase === 'wakes') return runWakes(context)
	if (phase === 'start') return { phase: 'start', ...await runStart(context, message) }
	if (phase === 'check') {
		const run = toStartedRun(await context.ctx.storage.get(STATE_KEY))
		if (!run) return { phase: 'check', error: 'no run recorded — call ?phase=start first' }
		return report(context, run, 'check')
	}
	if (phase === 'run') return runFull(context, message, Number(context.params.get('timeoutMs') ?? 20_000))
	throw new Error(`phase must be run, start, check, arm, wakes or spin (got '${phase}')`)
}
