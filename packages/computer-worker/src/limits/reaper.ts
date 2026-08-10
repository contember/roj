/**
 * What a session leaves behind, and what reaping it buys back.
 *
 * A DO was measured degrading by lifetime rather than by load — `createSession`
 * going from ~15 ms to ~110 ms on an object that had churned a few thousand
 * sessions — but two probes disagreed about the cause. The concurrency probe
 * blamed the debris a closed session leaves (6 238 entries under `/workspace`);
 * the memory probe blamed the per-session `git-status` interval that live
 * sessions arm. Neither separated the two, because in both of them the live
 * count and the lifetime count rose together.
 *
 * Four arms, `?arms=`, separate them. Every arm creates the same sessions with
 * the same debris; only what happens afterwards differs:
 *
 * - `all`       — create, close, reap the files *and* the event rows.
 * - `workspace` — create, close, reap the files only. Rows accumulate.
 * - `off`       — create, close, reap nothing. Live count stays at 1, debris grows.
 * - `off-do`    — `off` again, on the DO's own SessionManager.
 * - `hold`      — create and never close. Live count grows, debris grows with it.
 * - `hold-do`   — `hold` again, on the DO's own SessionManager.
 *
 * `off` against `all` is the reaper's value. `off` against `hold` is the open
 * question: same lifetime count, opposite live count. If `off` degrades on its
 * own then debris is the cause; if only `hold` degrades then holding sessions is.
 *
 * The `-do` pairs then split that answer once more. The plain arms build a
 * manager of their own on a `LiveScheduler` — which is what the two disputed
 * probes did, and the branch under which `git-status` refreshes on session ready
 * and arms a 2 s interval per open session. The `-do` arms drive the DO's own
 * manager on the alarm scheduler, where the plugin does neither. Same sessions,
 * same debris, one difference. Safe only because no arm here drives a turn:
 * there are no agent wakes to strand, and none to deliver into two managers.
 *
 * Every arm starts from the same clean DO — the reset between them uses the
 * reaper itself, which is also the strongest check that it works. Arms run
 * inside one request so a shared dev box loads them equally.
 *
 * `hold` is bounded by memory, not by patience: 600 live sessions of this shape
 * aborted workerd at V8's ~1.4 GB heap, so the default stays well under that.
 */

import { AgentId, SessionId, agentEvents, createSystemFromServices } from '@roj-ai/sdk'
import type { DomainEvent, Session } from '@roj-ai/sdk'
import type { FileSystem } from '@roj-ai/sdk/platform'
import { withOwnScheduler } from '../own-scheduler.js'
import { isolatePreset } from '../preset.js'
import type { IsolateSystem, LimitProbe, LimitProbeContext } from './context.js'

/** Whose SessionManager an arm drives — see systemFor. */
type ManagerKind = 'own' | 'do'

/** Where the preset interpolates `{sessionId}`, and where SessionManager puts session logs. */
const WORKSPACE_ROOT = '/workspace'
const SESSIONS_ROOT = '/data/sessions'

/** Depth of the recursive entry count — `/workspace/<session>/<file>` is all there is. */
const COUNT_DEPTH = 2

/** Directories one census makes and unmakes to price a mkdir. More than one, because ~1 ms is the clock's resolution here. */
const MKDIR_PROBE_COUNT = 20
const MKDIR_PROBE_PREFIX = `${WORKSPACE_ROOT}/.mkdir-probe-`

/** workerd freezes the clock between I/O, so a timer yield is needed before reading it. */
async function now(): Promise<number> {
	await scheduler.wait(0)
	return Date.now()
}

function int(params: URLSearchParams, name: string, fallback: number, min = 0): number {
	const raw = params.get(name)
	if (raw === null) return fallback
	const value = Number(raw)
	if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number >= ${min}`)
	return Math.floor(value)
}

function describe(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

// ============================================================================
// Census
// ============================================================================

interface Census {
	/** Top-level directories under /workspace — one per session this DO ever created. */
	workspaceDirs: number
	/** What listing that directory costs. */
	workspaceListMs: number
	/**
	 * One bare `mkdir` under /workspace, with the siblings above it.
	 *
	 * The attribution: createSession does two of these and nothing else that scales
	 * with the directory, so a mkdir that grows with the sibling count is the whole
	 * mechanism, and a flat one would mean the cost is somewhere in roj instead.
	 */
	mkdirMs: number
	/** Directories under /data/sessions — the session log SessionManager writes per session. */
	sessionDirs: number
	eventRows: number
	eventBytes: number
	metadataRows: number
	/** The whole DO database: event rows and the workspace's own vfs tables together. */
	sqlBytes: number
}

async function countDir(fs: FileSystem, path: string): Promise<number> {
	try {
		return (await fs.readdir(path)).length
	} catch {
		return 0
	}
}

/** Files and directories below `path`, so a per-session file count is visible, not just the dirs. */
async function countEntries(fs: FileSystem, path: string, depth = COUNT_DEPTH): Promise<number> {
	let total = 0
	let entries: Awaited<ReturnType<FileSystem['readdir']>>
	try {
		entries = await fs.readdir(path, { withFileTypes: true })
	} catch {
		return 0
	}
	for (const entry of entries) {
		total++
		if (depth > 1 && entry.isDirectory()) total += await countEntries(fs, `${path}/${entry.name}`, depth - 1)
	}
	return total
}

/** Mean cost of creating one directory under /workspace as it stands. Leaves nothing behind. */
async function timeMkdir(fs: FileSystem): Promise<number> {
	const start = await now()
	for (let index = 0; index < MKDIR_PROBE_COUNT; index++) {
		await fs.mkdir(`${MKDIR_PROBE_PREFIX}${index}`, { recursive: true })
	}
	const ms = (await now()) - start
	for (let index = 0; index < MKDIR_PROBE_COUNT; index++) {
		await fs.rm(`${MKDIR_PROBE_PREFIX}${index}`, { recursive: true, force: true })
	}
	return ms / MKDIR_PROBE_COUNT
}

async function census(context: LimitProbeContext): Promise<Census> {
	const { platform, ctx } = context
	const listStart = await now()
	const workspaceDirs = await countDir(platform.fs, WORKSPACE_ROOT)
	const workspaceListMs = (await now()) - listStart
	const mkdirMs = await timeMkdir(platform.fs)

	// roj's own tables, so direct SQL is fair game; the workspace's are not.
	const events = ctx.storage.sql
		.exec<{ rows: number; bytes: number | null }>('SELECT COUNT(*) AS rows, SUM(LENGTH(payload)) AS bytes FROM roj_events')
		.toArray()[0]
	const metadata = ctx.storage.sql
		.exec<{ rows: number }>('SELECT COUNT(*) AS rows FROM roj_session_metadata')
		.toArray()[0]

	return {
		workspaceDirs,
		workspaceListMs,
		mkdirMs,
		sessionDirs: await countDir(platform.fs, SESSIONS_ROOT),
		eventRows: events?.rows ?? 0,
		eventBytes: events?.bytes ?? 0,
		metadataRows: metadata?.rows ?? 0,
		sqlBytes: ctx.storage.sql.databaseSize,
	}
}

// ============================================================================
// Workload
// ============================================================================

interface ArmOptions {
	sessions: number
	step: number
	filesPerSession: number
	fileBytes: number
	eventsPerSession: number
	/** Sessions closed between sweeps. A host sweeps periodically, not per close. */
	reapEvery: number
	close: boolean
	reap: 'none' | 'workspace' | 'all'
	manager: ManagerKind
}

interface Checkpoint {
	created: number
	/** Mean and worst createSession since the previous checkpoint — the trend, not the average so far. */
	windowMeanCreateMs: number
	windowMaxCreateMs: number
	census: Census
}

interface ArmResult {
	arm: string
	reap: string
	close: boolean
	manager: ManagerKind
	checkpoints: Checkpoint[]
	/** Entries below /workspace at the end of the arm, files included. */
	workspaceEntries: number
	firstWindowMeanCreateMs: number
	lastWindowMeanCreateMs: number
	/** Last window against the first — 1.0 means creation did not degrade over the arm. */
	createGrowth: number
	reapSweeps: number
	reapMs: number
	reapedSessions: number
	totalMs: number
	error?: string
}

/**
 * Which SessionManager an arm drives.
 *
 * `own` is what every other probe uses: a manager of its own, on a
 * `LiveScheduler`, which is also the condition `git-status` arms its 2 s
 * interval under. `do` uses the DO's own manager on the alarm scheduler, where
 * the plugin arms nothing — so the pair separates the interval from the plain
 * cost of holding a session. Safe only because no arm here drives a turn: there
 * are no agent wakes to strand or to deliver twice.
 */
function systemFor(context: LimitProbeContext, manager: ManagerKind): IsolateSystem {
	const booted = context.boot()
	return manager === 'do' ? booted.system : createSystemFromServices(withOwnScheduler(booted.services))
}

/** Events a session of this shape would have written — the log a real turn leaves behind. */
function syntheticEvents(sessionId: SessionId, agentId: AgentId, count: number): DomainEvent[] {
	return Array.from({ length: count }, (_, index) =>
		Object.assign(
			agentEvents.create('agent_state_changed', {
				agentId,
				fromState: index % 2 === 0 ? 'pending' : 'inferring',
				toState: index % 2 === 0 ? 'inferring' : 'pending',
			}),
			{ sessionId },
		))
}

async function closeQuietly(session: Session): Promise<void> {
	try {
		await session.close()
	} catch {
		// Teardown failure must not lose the measurement that preceded it.
	}
}

async function runArm(context: LimitProbeContext, arm: string, options: ArmOptions): Promise<ArmResult> {
	const services = context.boot().services
	const system = systemFor(context, options.manager)
	const open: Session[] = []
	const checkpoints: Checkpoint[] = []

	let window: number[] = []
	let reapSweeps = 0
	let reapMs = 0
	let reapedSessions = 0
	let sinceSweep = 0
	let error: string | undefined
	const startedAt = await now()

	const sweep = async (): Promise<void> => {
		if (options.reap === 'none') return
		const start = await now()
		const report = await context.reaper.reap({ events: options.reap === 'all', limit: options.sessions })
		reapMs += (await now()) - start
		reapSweeps++
		reapedSessions += report.reaped.length
	}

	try {
		for (let index = 0; index < options.sessions; index++) {
			const start = await now()
			const created = await system.sessionManager.createSession(isolatePreset.id)
			window.push((await now()) - start)
			if (!created.ok) throw new Error(`createSession failed: ${JSON.stringify(created.error)}`)
			const session = created.value

			// Files an agent would have written, and the event log a few turns would leave.
			for (let file = 0; file < options.filesPerSession; file++) {
				await context.platform.fs.writeFile(`${WORKSPACE_ROOT}/${session.id}/f-${file}.txt`, 'x'.repeat(options.fileBytes))
			}
			const agentId = session.getEntryAgentId()
			if (agentId && options.eventsPerSession > 0) {
				await services.eventStore.appendBatch(session.id, syntheticEvents(session.id, agentId, options.eventsPerSession))
			}

			if (options.close) {
				await closeQuietly(session)
				sinceSweep++
				if (sinceSweep >= options.reapEvery) {
					await sweep()
					sinceSweep = 0
				}
			} else {
				open.push(session)
			}

			if ((index + 1) % options.step !== 0 && index + 1 !== options.sessions) continue
			checkpoints.push({
				created: index + 1,
				windowMeanCreateMs: window.reduce((sum, ms) => sum + ms, 0) / window.length,
				windowMaxCreateMs: Math.max(...window),
				census: await census(context),
			})
			window = []
		}
		if (sinceSweep > 0) await sweep()
	} catch (failure) {
		error = describe(failure)
	} finally {
		// Held sessions arm a git-status interval each; leaving them running would
		// poison the next arm, and the reset cannot reap what is not closed.
		for (const session of open) await closeQuietly(session)
	}

	const first = checkpoints[0]
	const last = checkpoints[checkpoints.length - 1]
	return {
		arm,
		reap: options.reap,
		close: options.close,
		manager: options.manager,
		checkpoints,
		workspaceEntries: await countEntries(context.platform.fs, WORKSPACE_ROOT),
		firstWindowMeanCreateMs: first?.windowMeanCreateMs ?? 0,
		lastWindowMeanCreateMs: last?.windowMeanCreateMs ?? 0,
		createGrowth: first && last && first.windowMeanCreateMs > 0 ? last.windowMeanCreateMs / first.windowMeanCreateMs : 0,
		reapSweeps,
		reapMs,
		reapedSessions,
		totalMs: (await now()) - startedAt,
		error,
	}
}

// ============================================================================
// Probe
// ============================================================================

interface Reset {
	before: Census
	after: Census
	reapedSessions: number
	ms: number
}

/**
 * Put the DO back to a clean state between arms.
 *
 * Everything is closed by the time this runs, so a full reap empties both the
 * files and the rows. `sqlBytes` deliberately stays in the report: SQLite frees
 * the pages but never shrinks the file, so the only honest way to read it is as
 * a high-water mark.
 */
async function reset(context: LimitProbeContext): Promise<Reset> {
	const before = await census(context)
	const start = await now()
	const report = await context.reaper.reap({ events: true, limit: Number.MAX_SAFE_INTEGER })
	const ms = (await now()) - start
	return { before, after: await census(context), reapedSessions: report.reaped.length, ms }
}

const ALL_ARMS = ['all', 'workspace', 'off', 'off-do', 'hold', 'hold-do'] as const

type ArmName = (typeof ALL_ARMS)[number]

function armOptions(arm: ArmName, base: Omit<ArmOptions, 'close' | 'reap' | 'manager'>): ArmOptions {
	if (arm === 'hold') return { ...base, close: false, reap: 'none', manager: 'own' }
	if (arm === 'hold-do') return { ...base, close: false, reap: 'none', manager: 'do' }
	if (arm === 'off') return { ...base, close: true, reap: 'none', manager: 'own' }
	if (arm === 'off-do') return { ...base, close: true, reap: 'none', manager: 'do' }
	return { ...base, close: true, reap: arm === 'all' ? 'all' : 'workspace', manager: 'own' }
}

export const reaperProbe: LimitProbe = async (context) => {
	const { params } = context
	const requested = (params.get('arms') ?? ALL_ARMS.join(',')).split(',')
	const arms = requested.filter((name): name is ArmName => ALL_ARMS.some((known) => known === name))
	if (arms.length !== requested.length) {
		throw new Error(`unknown arms: ${requested.filter((name) => !arms.some((known) => known === name)).join(',')} (known: ${ALL_ARMS.join(',')})`)
	}

	const base = {
		sessions: int(params, 'sessions', 300, 1),
		step: int(params, 'step', 50, 1),
		filesPerSession: int(params, 'filesPerSession', 3),
		fileBytes: int(params, 'fileBytes', 512),
		eventsPerSession: int(params, 'eventsPerSession', 24),
		reapEvery: int(params, 'reapEvery', 8, 1),
	}

	const startedAt = await now()
	const results: ArmResult[] = []
	const resets: Reset[] = []

	// The first createSession of a run pays for booting the SDK and for every cold
	// code path under it, which would otherwise land entirely in the first arm's
	// first window and read as degradation running backwards.
	const warmupSessions = int(params, 'warmup', 5, 1)
	const warmup = await runArm(context, 'warmup', armOptions('all', { ...base, sessions: warmupSessions, step: warmupSessions }))

	for (const arm of arms) {
		// Before, not after: an arm must not inherit the previous one's debris, and
		// the last arm's leftovers stay readable in the report.
		resets.push(await reset(context))
		results.push(await runArm(context, arm, armOptions(arm, base)))
	}

	const growth = Object.fromEntries(results.map((result) => [result.arm, result.createGrowth]))

	return {
		arms,
		params: base,
		warmup,
		resets,
		results,
		createGrowth: growth,
		totalMs: (await now()) - startedAt,
		notes: [
			'every arm creates the same sessions with the same files and the same event log; only the teardown differs',
			'createGrowth is the last window of createSession against the first, inside one arm — read it before any absolute ms',
			'off vs all is what the reaper buys; off vs hold is which of live count and lifetime count actually costs',
			'hold vs hold-do prices the git-status interval alone: hold runs on a LiveScheduler where the plugin arms 2 s per open session, hold-do on the DO\'s alarm scheduler where it arms nothing',
			'hold is bounded by memory — 600 live sessions of this shape aborted workerd at V8\'s ~1.4 GB heap, and production gets 128 MB',
			'mkdirMs is the attribution: createSession makes two directories and does nothing else that scales with a sibling count, so a mkdir that tracks workspaceDirs is the whole mechanism',
			'sqlBytes never falls: SQLite frees pages on DELETE but does not shrink the file, so it is a high-water mark and the row counts are the real signal',
			'the reset between arms uses the reaper itself, so a reset that leaves anything behind is a reaper bug and shows up in the after census',
			'wrangler dev on a shared box — compare arms inside one run, never across runs',
		],
	}
}
