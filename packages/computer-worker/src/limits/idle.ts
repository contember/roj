/**
 * What is still armed once a session has settled.
 *
 * A Durable Object can only be evicted when it has nothing outstanding, and
 * workerd counts an armed actor timer as outstanding: every one registers a
 * wait-until task that `IncomingRequest::drain()` waits for
 * (`io-context.c++:828`), and a repeating timer arms a fresh one on every tick
 * (`io-context.c++:793`). One `setInterval` anywhere in the isolate is therefore
 * enough to keep the object awake forever — which is what the `git-status` poll
 * used to be, once per live session.
 *
 * Three things have to be empty at rest, and this probe reads all three:
 *
 * - **timers** — `setTimeout`/`setInterval` armed and not yet cleared. The
 *   census wraps the globals before the SDK boots, so anything roj arms is
 *   counted, with the stack frame that armed it.
 * - **wakes** — the scheduler's rows, the alarm-driven half of the agent loop.
 * - **the alarm slot** — what `ctx.storage.getAlarm()` actually holds.
 *
 * The run sends a message, settles, waits out a quiet window longer than any
 * interval roj has ever armed, drops the booted SDK the way an eviction would,
 * then sends a second message that can only be served by reloading the session
 * from its event log — and settles again.
 *
 * It also prices what the poll used to buy. The workspace starts as a real repo,
 * and between the two turns the probe writes a file straight through
 * `platform.fs` — a write with no tool call behind it. Nothing notices it, which
 * is correct here and would not be on a host where a user has the directory open
 * in an editor: `git-status.refresh` is what surfaces it, and `snapshots` shows
 * that turning over.
 *
 * **Eviction itself is not observed.** `wrangler dev` never evicts a Durable
 * Object, so what this shows is the precondition for hibernation — nothing
 * outstanding — and never hibernation itself. Only a deployed DO settles that.
 */

import { SessionId, createSystemFromServices } from '@roj-ai/sdk'
import type { AlarmSchedulerStats } from '@roj-ai/computer-platform'
import type { DomainEvent, Services, Session } from '@roj-ai/sdk'
import { NOTE_PATH } from '../mock-llm.js'
import { withOwnScheduler } from '../own-scheduler.js'
import { isolatePreset } from '../preset.js'
import type { Booted, LimitProbe, LimitProbeContext } from './context.js'

/** The writer agent's output, under the session's own workspace directory. */
const NOTE_NAME = NOTE_PATH.split('/').pop() ?? 'note.md'

/** Longer than the 2 s `git-status` used to poll at, so a surviving clock would show. */
const DEFAULT_QUIET_MS = 6000

/** A clean repo to read against, so the snapshots below say something. */
const REPO_SETUP = ['git init', 'echo "seed" > seed.txt', 'git add seed.txt', 'git commit -m "seed"'] as const

/** Written straight through the filesystem port — the writer a tool call never runs. */
const OUT_OF_BAND_FILE = 'edited-elsewhere.txt'

interface ArmedTimer {
	kind: 'timeout' | 'interval'
	delayMs: number
	/** Frames below the wrapper — enough to name whichever module armed it. */
	origin: string
}

interface TimerCensus {
	/** Timers armed since the census was installed. */
	armed: number
	/** Of those, explicitly cleared. One-shots that simply fired count in neither. */
	cleared: number
	outstanding: ArmedTimer[]
}

interface CensusState {
	armed: number
	cleared: number
	live: Map<number, ArmedTimer>
}

/** Installed once per isolate; a second probe call reuses the same counters. */
let censusState: CensusState | undefined

function originOf(): string {
	const frames = (new Error().stack ?? '').split('\n').slice(2, 5)
	return frames.map((frame) => frame.trim()).join(' | ')
}

/**
 * Wrap the timer globals so every arm is counted.
 *
 * Nothing else can see an actor timer from inside the isolate: workerd exposes
 * no handle on its wait-until queue, so the only honest census is to be the one
 * handing the timers out.
 */
function installTimerCensus(): CensusState {
	const existing = censusState
	if (existing) return existing

	const state: CensusState = { armed: 0, cleared: 0, live: new Map() }
	censusState = state

	const nativeSetTimeout = globalThis.setTimeout
	const nativeClearTimeout = globalThis.clearTimeout
	const nativeSetInterval = globalThis.setInterval
	const nativeClearInterval = globalThis.clearInterval

	const forget = (handle: number | null): void => {
		if (handle === null) return
		if (state.live.delete(handle)) state.cleared += 1
	}

	globalThis.setTimeout = (callback: (...args: unknown[]) => void, msDelay?: number, ...args: unknown[]) => {
		// A one-shot stops holding the actor when it fires, not only when it is cleared.
		const handle: number = nativeSetTimeout((...fired: unknown[]) => {
			state.live.delete(handle)
			callback(...fired)
		}, msDelay, ...args)
		state.armed += 1
		state.live.set(handle, { kind: 'timeout', delayMs: msDelay ?? 0, origin: originOf() })
		return handle
	}
	globalThis.clearTimeout = (handle: number | null) => {
		forget(handle)
		nativeClearTimeout(handle)
	}
	globalThis.setInterval = (callback: (...args: unknown[]) => void, msDelay?: number, ...args: unknown[]) => {
		const handle = nativeSetInterval(callback, msDelay, ...args)
		state.armed += 1
		state.live.set(handle, { kind: 'interval', delayMs: msDelay ?? 0, origin: originOf() })
		return handle
	}
	globalThis.clearInterval = (handle: number | null) => {
		forget(handle)
		nativeClearInterval(handle)
	}

	return state
}

function readCensus(state: CensusState): TimerCensus {
	return { armed: state.armed, cleared: state.cleared, outstanding: [...state.live.values()] }
}

/**
 * Prove the census can see a timer at all, so a later zero means something.
 *
 * Without this a broken wrapper and an idle isolate report identically.
 */
function selfCheck(state: CensusState): string {
	const before = state.live.size
	const handle = setInterval(() => {}, 60_000)
	const seen = state.live.size === before + 1
	clearInterval(handle)
	const gone = state.live.size === before
	return seen && gone ? 'ok' : `broken (seen=${seen}, cleared=${gone})`
}

/** workerd pins the clock between I/O, so yield before reading it. */
async function now(): Promise<number> {
	await scheduler.wait(0)
	return Date.now()
}

interface Checkpoint {
	at: string
	elapsedMs: number
	timers: TimerCensus
	wakes: AlarmSchedulerStats
	alarmAt: number | null
	events: number
}

async function countEvents(services: Services<'isolate'>, sessionId: string): Promise<number> {
	const events: DomainEvent[] = await services.eventStore.load(SessionId(sessionId))
	return events.length
}

async function checkpoint(
	context: LimitProbeContext,
	state: CensusState,
	at: string,
	sessionId: string,
	startedAt: number,
): Promise<Checkpoint> {
	return {
		at,
		elapsedMs: (await now()) - startedAt,
		timers: readCensus(state),
		wakes: context.scheduler.stats(),
		alarmAt: await context.ctx.storage.getAlarm(),
		events: await countEvents(context.boot().services, sessionId),
	}
}

/** True once every agent has stopped working and nothing is scheduled. */
function agentsIdle(session: Session): boolean {
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

/**
 * Wait until the agents are idle and the scheduler holds nothing.
 *
 * Polling with `scheduler.wait` rather than a timer keeps the census honest —
 * the probe's own waiting must not show up as work the session is holding.
 */
async function settle(context: LimitProbeContext, session: Session, timeoutMs: number): Promise<boolean> {
	const deadline = (await now()) + timeoutMs
	while ((await now()) < deadline) {
		if (agentsIdle(session) && context.scheduler.stats().pending === 0) return true
		await scheduler.wait(50)
	}
	return false
}

async function sendMessage(session: Session, content: string): Promise<void> {
	const entryAgentId = session.getEntryAgentId()
	if (!entryAgentId) throw new Error('preset has no entry agent')
	const sent = await session.callPluginMethod('user-chat.sendMessage', {
		sessionId: String(session.id),
		content,
		agentId: String(entryAgentId),
	})
	if (!sent.ok) throw new Error(`sendMessage failed: ${JSON.stringify(sent.error)}`)
}

async function startSession(booted: Booted): Promise<Session> {
	const created = await booted.system.sessionManager.createSession(isolatePreset.id)
	if (!created.ok) throw new Error(`createSession failed: ${JSON.stringify(created.error)}`)
	return created.value
}

/** Whether the manager holds this session in memory — without loading it back if not. */
async function isInMemory(booted: Booted, sessionId: string): Promise<boolean> {
	const stats = await booted.system.sessionManager.getStats()
	return stats.sessions.some((entry) => String(entry.id) === sessionId)
}

async function readNote(context: LimitProbeContext, sessionId: string): Promise<string | null> {
	try {
		return await context.platform.fs.readFile(`/workspace/${sessionId}/${NOTE_NAME}`, 'utf-8')
	} catch {
		return null
	}
}

/** Turn the fresh session workspace into a repo with one commit. */
async function seedRepo(context: LimitProbeContext, sessionId: string): Promise<string> {
	try {
		for (const command of REPO_SETUP) {
			const handle = await context.workspace.runtime.exec(command, {
				backend: context.backend,
				encoding: 'utf8',
				cwd: `/workspace/${sessionId}`,
			})
			try {
				const result = await handle.result()
				if (result.exitCode !== 0) return `failed: ${command} exited ${result.exitCode}`
			} finally {
				handle[Symbol.dispose]()
			}
		}
		return 'ready'
	} catch (error) {
		return `failed: ${error instanceof Error ? error.message : String(error)}`
	}
}

/**
 * The control that makes an empty census mean something.
 *
 * `withOwnScheduler` hands the SDK a `LiveScheduler` — what a Bun host has — so
 * `git-status` arms its 2 s clock, and the census must see it appear and go. A
 * run where this stays empty proves nothing about the run above.
 */
async function runControl(context: LimitProbeContext, state: CensusState): Promise<unknown> {
	const system = createSystemFromServices(withOwnScheduler(context.boot().services))
	const before = readCensus(state)
	const created = await system.sessionManager.createSession(isolatePreset.id)
	if (!created.ok) throw new Error(`control createSession failed: ${JSON.stringify(created.error)}`)

	await scheduler.wait(50)
	const withLiveSession = readCensus(state)

	// close() emits; the hook that clears the interval runs off that event.
	await created.value.close()
	await scheduler.wait(50)
	const afterClose = readCensus(state)
	await system.shutdown()

	return {
		host: 'LiveScheduler, as a Bun host has',
		before,
		withLiveSession,
		afterClose,
		reads: 'withLiveSession must hold a git-status interval — that is the census working.',
	}
}

/** Ask the plugin for the workspace's git state, the way a client does. */
async function pullGitStatus(session: Session): Promise<unknown> {
	const pulled = await session.callPluginMethod('git-status.refresh', { sessionId: String(session.id) })
	return pulled.ok ? pulled.value : { error: pulled.error }
}

export const idleProbe: LimitProbe = async (context) => {
	// Before anything boots, or the SDK's first timers are armed unseen.
	const state = installTimerCensus()
	const censusSelfCheck = selfCheck(state)

	const quietMs = Number(context.params.get('quietMs') ?? DEFAULT_QUIET_MS)
	const timeoutMs = Number(context.params.get('timeoutMs') ?? 20_000)
	const startedAt = await now()

	const session = await startSession(context.boot())
	const sessionId = String(session.id)
	const checkpoints: Checkpoint[] = []
	const snapshots: Record<string, unknown> = {}
	const repo = await seedRepo(context, sessionId)

	await sendMessage(session, context.params.get('message') ?? 'Please write a note file.')
	const firstSettled = await settle(context, session, timeoutMs)
	checkpoints.push(await checkpoint(context, state, 'settled', sessionId, startedAt))
	// The writer agent's file is a tool call, so the turn boundary already read it.
	snapshots.afterTurn = await pullGitStatus(session)

	// A write with no tool call and no request behind it. On this host nothing but a
	// pull can see it; on a Bun host the poll would, which is why the poll stays there.
	await context.platform.fs.writeFile(`/workspace/${sessionId}/${OUT_OF_BAND_FILE}`, 'written outside any turn\n')

	// A clock would re-arm inside this window; nothing that only reacts to work can.
	await scheduler.wait(quietMs)
	checkpoints.push(await checkpoint(context, state, `quiet+${quietMs}ms`, sessionId, startedAt))
	snapshots.afterOutOfBandWrite = await pullGitStatus(session)

	// Drop the SDK the way an eviction would: no SessionManager, no agents, no state.
	const evicted = await context.evictSdk(true)
	await context.scheduler.flush()
	checkpoints.push(await checkpoint(context, state, 'evicted', sessionId, startedAt))

	// Resume: this manager has never seen the session, so the second message can
	// only be served by replaying its event log.
	const resumedBoot = context.boot()
	const inMemoryBeforeResume = await isInMemory(resumedBoot, sessionId)
	const reopened = await resumedBoot.system.sessionManager.getSession(SessionId(sessionId))
	if (!reopened.ok) throw new Error(`getSession failed: ${JSON.stringify(reopened.error)}`)

	await sendMessage(reopened.value, context.params.get('message2') ?? 'Anything else to report?')
	const secondSettled = await settle(context, reopened.value, timeoutMs)
	checkpoints.push(await checkpoint(context, state, 'settled again', sessionId, startedAt))

	// The pull that replaced the poll, on a session with no history in this manager.
	snapshots.afterResume = await pullGitStatus(reopened.value)
	checkpoints.push(await checkpoint(context, state, 'after git-status pull', sessionId, startedAt))

	// Last, so a control session that leaked could not have polluted the checkpoints.
	const control = context.params.get('control') === '0' ? 'skipped' : await runControl(context, state)

	const last = checkpoints[checkpoints.length - 1]
	return {
		sessionId,
		censusSelfCheck,
		repo,
		firstSettled,
		secondSettled,
		evicted,
		// False is the point: the resumed turn came off the event log, not off memory.
		inMemoryBeforeResume,
		agentsAfterResume: reopened.value.state.agents.size,
		note: await readNote(context, sessionId),
		snapshots,
		checkpoints,
		control,
		holdingTheDo: last === undefined || (last.timers.outstanding.length === 0 && last.wakes.pending === 0 && last.alarmAt === null)
			? 'nothing'
			: 'see the last checkpoint',
		note_wranglerDev: 'wrangler dev never evicts a DO. This shows the precondition for hibernation, not hibernation.',
	}
}
