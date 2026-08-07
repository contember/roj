/**
 * What keeps roj's agent loop running when no request is in flight.
 *
 * `Agent.scheduleProcessing` re-enters through `setTimeout` (500 ms debounce by
 * default). A Worker gives that no guarantees: the isolate lives while a request
 * is in flight, while `waitUntil` is pending, or while a non-hibernated
 * WebSocket is attached — a bare timer buys nothing, and neither this harness
 * nor the transport calls `waitUntil` or sets an alarm. So a session started by
 * a request that returns early may simply stop.
 *
 * `?phase=` runs one half of the experiment:
 *
 * - `held` — start a session and stay in the request until it goes idle. The
 *   control: progress here proves the loop works when something holds the DO.
 * - `start` — start a session and return immediately, holding nothing.
 * - `check` — report what the `start` session has done since, without driving it.
 * - `pump` — re-enter the DO for `?ms=` and report what drained while inside.
 *
 * Run `start`, wait outside, then `check`: the gap between the event count at
 * return and the count now is what an unheld loop achieved on its own.
 */

import { SessionId } from '@roj-ai/sdk'
import type { DomainEvent, Services, Session } from '@roj-ai/sdk'
import { isolatePreset } from '../preset.js'
import type { Booted, LimitProbe, LimitProbeContext } from './context.js'

const STATE_KEY = 'limits:lifecycle:run'

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
}

function toStartedRun(value: unknown): StartedRun | null {
	if (typeof value !== 'object' || value === null) return null
	if (!('sessionId' in value && 'isolate' in value && 'startedAt' in value && 'eventsAtReturn' in value)) return null
	const { sessionId, isolate, startedAt, eventsAtReturn } = value
	if (typeof sessionId !== 'string' || typeof isolate !== 'string') return null
	if (typeof startedAt !== 'number' || typeof eventsAtReturn !== 'number') return null
	return { sessionId, isolate, startedAt, eventsAtReturn }
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

/** Whether the manager still holds this session in memory — without loading it back if not. */
async function isInMemory(booted: Booted, sessionId: string): Promise<boolean> {
	const stats = await booted.system.sessionManager.getStats()
	return stats.sessions.some((entry) => String(entry.id) === sessionId)
}

/** True once every agent has stopped working and nothing is scheduled. */
function isIdle(session: Session): boolean {
	for (const [agentId] of session.state.agents) {
		const agent = session.getAgent(agentId)
		const state = agent?.state
		if (!agent || !state) continue
		if (state.status !== 'pending') return false
		if (state.pendingToolCalls.length > 0 || state.pendingToolResults.length > 0) return false
		if (agent.isScheduled()) return false
	}
	return true
}

async function runHeld(context: LimitProbeContext, message: string, timeoutMs: number): Promise<unknown> {
	const booted = context.boot()
	const startedAt = await now()
	const session = await startSession(booted, message)

	let settled = false
	while ((await now()) - startedAt < timeoutMs) {
		if (isIdle(session)) {
			settled = true
			break
		}
		await scheduler.wait(50)
	}

	return {
		phase: 'held',
		isolate: currentIsolate(),
		sessionId: String(session.id),
		settled,
		elapsedMs: (await now()) - startedAt,
		events: await countEvents(booted.services, String(session.id)),
		note: 'The request stayed in flight throughout, so the isolate could not be evicted.',
	}
}

async function runStart(context: LimitProbeContext, message: string): Promise<unknown> {
	const booted = context.boot()
	const startedAt = await now()
	const session = await startSession(booted, message)
	const eventsAtReturn = await countEvents(booted.services, String(session.id))

	const run: StartedRun = { sessionId: String(session.id), isolate: currentIsolate(), startedAt, eventsAtReturn }
	await context.ctx.storage.put(STATE_KEY, run)

	return {
		phase: 'start',
		...run,
		note: 'Returning now. Nothing holds the DO — no waitUntil, no alarm, no attached socket.',
	}
}

async function runCheck(context: LimitProbeContext): Promise<unknown> {
	const run = toStartedRun(await context.ctx.storage.get(STATE_KEY))
	if (!run) return { phase: 'check', error: 'no run recorded — call ?phase=start first' }

	const booted = context.boot()
	const events = await countEvents(booted.services, run.sessionId)
	const isolate = currentIsolate()
	return {
		phase: 'check',
		...run,
		isolateNow: isolate,
		isolateRestarted: isolate !== run.isolate,
		sessionStillInMemory: await isInMemory(booted, run.sessionId),
		eventsNow: events,
		// The whole question: did anything happen while no request was in flight?
		progressedWhileUnheld: events - run.eventsAtReturn,
		elapsedMs: (await now()) - run.startedAt,
	}
}

async function runPump(context: LimitProbeContext, pumpMs: number): Promise<unknown> {
	const run = toStartedRun(await context.ctx.storage.get(STATE_KEY))
	if (!run) return { phase: 'pump', error: 'no run recorded — call ?phase=start first' }

	const booted = context.boot()
	const before = await countEvents(booted.services, run.sessionId)
	await scheduler.wait(pumpMs)
	const after = await countEvents(booted.services, run.sessionId)

	return {
		phase: 'pump',
		sessionId: run.sessionId,
		isolateNow: currentIsolate(),
		isolateRestarted: currentIsolate() !== run.isolate,
		pumpMs,
		before,
		after,
		// Progress here but none in `check` means the loop needs a request to ride on.
		drainedWhileHeld: after - before,
	}
}

export const lifecycleProbe: LimitProbe = async (context) => {
	const phase = context.params.get('phase') ?? 'held'
	const message = context.params.get('message') ?? 'Please write a note file.'

	if (phase === 'held') return runHeld(context, message, Number(context.params.get('timeoutMs') ?? 20_000))
	if (phase === 'start') return runStart(context, message)
	if (phase === 'check') return runCheck(context)
	if (phase === 'pump') return runPump(context, Number(context.params.get('ms') ?? 3000))
	throw new Error(`phase must be held, start, check or pump (got '${phase}')`)
}
