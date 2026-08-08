/**
 * What one Durable Object carries at once.
 *
 * A DO is single-threaded and roj's multi-agent model assumes agents make
 * progress in parallel, so the two have to be reconciled by measurement. Four
 * dimensions, each selectable through `?dims=`:
 *
 * - `agents`   — N agents inferring at once: does wall time stay flat or grow with N?
 * - `sessions` — how many live sessions one DO holds, and what degrades first.
 * - `exec`     — concurrent `runtime.exec` through the Dynamic Worker shell.
 * - `gate`     — whether a storage write stalls unrelated timer-driven progress.
 *
 * Every dimension is tuned from the query string, so one can be re-run alone:
 * `agentCounts` `agentDelayMs` `agentBurnMs` `agentTurns` `agentMode` `debounceMs`,
 * `sessionMax` `sessionStep` `sessionIdleMs` `sessionDrive`,
 * `execCounts` `execCmd` `execCeiling`, `gateOps` `gateIdleMs`.
 *
 * There is no API key here, so every inference is the scripted mock: network
 * cost is excluded by construction, and `agentDelayMs` stands in for it. The
 * numbers therefore describe roj's own scheduling, not production wall time.
 */

import type { Workspace } from '@cloudflare/computer'
import { MockLLMProvider, ModelId, agentEvents, createOrchestrator, createPreset, createSystemFromServices, defineAgent } from '@roj-ai/sdk'
import type { AgentId, DomainEvent, MockInferenceHandler, Preset, Services, Session } from '@roj-ai/sdk'
import { ToolCallId } from '@roj-ai/sdk/tools'
import { filesystemPlugin } from '@roj-ai/sdk/tools/filesystem'
import { withOwnScheduler } from '../own-scheduler.js'
import type { IsolateSystem, LimitProbe, LimitProbeContext } from './context.js'

const PRESET_ID = 'concurrency-probe'
const WORKER_AGENT = 'worker'
/** Sandboxed agents see virtual paths, so tool inputs must use them. */
const VIRTUAL_WORKSPACE = '/home/user/workspace'
const GATE_DIR = '/probe-gate'
const GATE_KEY_PREFIX = 'concurrency-gate:'

/** Guards a run that never settles — every wait reports failure rather than hanging. */
const SETTLE_TIMEOUT_MS = 60_000

/** workerd freezes the clock between I/O, so a timer yield is needed before reading it. */
async function now(): Promise<number> {
	await scheduler.wait(0)
	return Date.now()
}

// ============================================================================
// Parameters
// ============================================================================

function text(params: URLSearchParams, key: string, fallback: string): string {
	return params.get(key) ?? fallback
}

function count(params: URLSearchParams, key: string, fallback: number): number {
	const raw = params.get(key)
	if (raw === null) return fallback
	const parsed = Number(raw)
	if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number`)
	return parsed
}

function counts(params: URLSearchParams, key: string, fallback: readonly number[]): number[] {
	const raw = params.get(key)
	if (raw === null) return [...fallback]
	const parsed = raw.split(',').map(Number)
	if (parsed.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
		throw new Error(`${key} must be a comma-separated list of positive integers`)
	}
	return parsed
}

// ============================================================================
// Instruments
// ============================================================================

/** Integer mixing loop. The clock is frozen inside sync code, so CPU is spent in iterations, not ms. */
function spin(iterations: number): number {
	let acc = 1
	for (let i = 0; i < iterations; i++) acc = (acc * 31 + i) | 0
	return acc
}

/** Iterations of `spin` worth roughly 1 ms here, so a burn can be asked for in ms. */
async function calibrateSpin(): Promise<number> {
	const iterations = 4_000_000
	let fastest = 0
	// Best of three: the dev box is shared, so the least-contended round is the honest rate.
	for (let round = 0; round < 3; round++) {
		const start = await now()
		spin(iterations)
		const ms = (await now()) - start
		if (ms > 0) fastest = Math.max(fastest, iterations / ms)
	}
	return fastest === 0 ? iterations : fastest
}

interface HeartbeatSummary {
	periodMs: number
	ticks: number
	/** Ticks actually delivered per second. Against 1000/periodMs it is a thread-occupancy ratio. */
	ticksPerSecond: number
	/** How late each tick ran against its own deadline — how long the thread was held. */
	medianLateMs: number
	maxLateMs: number
}

/**
 * A timer that should fire every `periodMs`.
 *
 * Lateness is the only view an isolate has of "someone else is holding the
 * thread": nothing else in the workload can run while a synchronous stretch of
 * agent work, SQL or replay is in progress.
 */
function startHeartbeat(periodMs: number): () => HeartbeatSummary {
	const late: number[] = []
	const startedAt = Date.now()
	let deadline = startedAt + periodMs
	let timer: ReturnType<typeof setTimeout> | undefined

	const tick = () => {
		const at = Date.now()
		late.push(at - deadline)
		deadline = at + periodMs
		timer = setTimeout(tick, periodMs)
	}
	timer = setTimeout(tick, periodMs)

	return () => {
		if (timer !== undefined) clearTimeout(timer)
		const elapsedMs = Math.max(Date.now() - startedAt, 1)
		const sorted = [...late].sort((a, b) => a - b)
		const ticksPerSecond = (sorted.length * 1000) / elapsedMs
		if (sorted.length === 0) return { periodMs, ticks: 0, ticksPerSecond, medianLateMs: 0, maxLateMs: 0 }
		return {
			periodMs,
			ticks: sorted.length,
			ticksPerSecond,
			medianLateMs: sorted[Math.floor(sorted.length / 2)],
			maxLateMs: sorted[sorted.length - 1],
		}
	}
}

interface Span {
	startMs: number
	endMs: number
	ok: boolean
	detail?: string
}

/** Highest number of spans alive at the same instant — overlap, measured rather than assumed. */
function maxOverlap(spans: readonly Span[]): number {
	const points = spans.flatMap((span) => [{ at: span.startMs, delta: 1 }, { at: span.endMs, delta: -1 }])
	// Ends settle before starts at equal timestamps, so a tie never inflates the peak.
	points.sort((a, b) => a.at - b.at || a.delta - b.delta)
	let live = 0
	let peak = 0
	for (const point of points) {
		live += point.delta
		if (live > peak) peak = live
	}
	return peak
}

function describe(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

// ============================================================================
// Scripted workload
// ============================================================================

interface ScriptOptions {
	/** Async wait per inference — stands in for the network the mock removes. */
	delayMs: number
	/** Synchronous CPU per inference, in `spin` iterations. */
	burnIterations: number
	/** Assistant turns a worker takes; every turn but the last writes a file. */
	turns: number
	/** start_worker calls the orchestrator makes on its first turn (fanout mode only). */
	spawnCount: number
}

interface Script {
	handler: MockInferenceHandler
	/** `maxInFlight` is direct evidence of overlap, independent of wall-clock noise. */
	peak: () => { calls: number; maxInFlight: number }
}

function createScript(options: ScriptOptions): Script {
	let calls = 0
	let inFlight = 0
	let maxInFlight = 0
	let sequence = 0

	const handler: MockInferenceHandler = async (request) => {
		calls++
		inFlight++
		if (inFlight > maxInFlight) maxInFlight = inFlight
		try {
			if (options.burnIterations > 0) spin(options.burnIterations)
			if (options.delayMs > 0) await scheduler.wait(options.delayMs)

			const offered = new Set((request.tools ?? []).map((tool) => tool.name))
			const spawnTool = `start_${WORKER_AGENT}`
			const assistantTurns = request.messages.filter((message) => message.role === 'assistant').length
			const metrics = MockLLMProvider.defaultMetrics()

			if (options.spawnCount > 0 && offered.has(spawnTool) && assistantTurns === 0) {
				return {
					content: `Spawning ${options.spawnCount} workers.`,
					toolCalls: Array.from({ length: options.spawnCount }, () => {
						sequence++
						return { id: ToolCallId(`spawn-${sequence}`), name: spawnTool, input: { message: 'Do one unit of work.' } }
					}),
					finishReason: 'tool_calls',
					metrics,
				}
			}

			// Workers alone hold write_file without the spawn tool; extra turns keep them busy.
			if (offered.has('write_file') && !offered.has(spawnTool) && assistantTurns < options.turns - 1) {
				sequence++
				return {
					content: 'Writing.',
					toolCalls: [{
						id: ToolCallId(`write-${sequence}`),
						name: 'write_file',
						input: { path: `${VIRTUAL_WORKSPACE}/turn-${sequence}.txt`, content: `turn ${assistantTurns}\n` },
					}],
					finishReason: 'tool_calls',
					metrics,
				}
			}

			return { content: 'Done.', toolCalls: [], finishReason: 'stop', metrics }
		} finally {
			inFlight--
		}
	}

	return { handler, peak: () => ({ calls, maxInFlight }) }
}

function buildPreset(debounceMs: number): Preset {
	const worker = defineAgent({
		name: WORKER_AGENT,
		system: 'You do one small unit of work, then stop.',
		model: ModelId('mock/model'),
		plugins: [filesystemPlugin.configureAgent({ directoryListing: { maxDepth: 1 } })],
		tools: [],
		agents: [],
		debounceMs,
	})

	return createPreset({
		id: PRESET_ID,
		name: 'Concurrency probe',
		workspaceDir: '/workspace/{sessionId}',
		// Relative agent paths would resolve against process.cwd(), which an isolate lacks.
		sandboxed: true,
		orchestrator: createOrchestrator({
			system: 'You delegate units of work to worker agents.',
			model: ModelId('mock/model'),
			plugins: [filesystemPlugin.configureAgent({ directoryListing: { maxDepth: 1 } })],
			tools: [],
			agents: [worker],
			debounceMs,
		}),
	})
}

/** A System of its own per run, so each measurement gets a fresh script and preset. */
function systemFor(base: Services<'isolate'>, preset: Preset, handler: MockInferenceHandler): IsolateSystem {
	const mock = new MockLLMProvider(handler)
	return createSystemFromServices({
		...withOwnScheduler(base),
		llmProvider: mock,
		llmProviders: new Map([['mock', mock]]),
		presets: new Map([[preset.id, preset]]),
	})
}

// ============================================================================
// Session helpers
// ============================================================================

function assistantTurns(session: Session, agentId: AgentId): number {
	const state = session.getAgent(agentId)?.state
	if (!state) return 0
	return state.conversationHistory.filter((message) => message.role === 'assistant').length
}

function busy(session: Session, agentId: AgentId): boolean {
	const agent = session.getAgent(agentId)
	const state = agent?.state
	if (!agent || !state) return true
	return state.status !== 'pending'
		|| state.pendingToolCalls.length > 0
		|| state.pendingToolResults.length > 0
		|| agent.isScheduled()
}

/**
 * Wait until every named agent has produced `minTurns` assistant messages and gone quiet.
 *
 * The turn count is what makes this deterministic: an agent that has been
 * spawned but not yet scheduled also looks idle, and would otherwise settle
 * the wait before it has done any work at all.
 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return true
		await scheduler.wait(10)
	}
	return false
}

function waitForTurns(session: Session, agentIds: readonly AgentId[], minTurns: number, timeoutMs: number): Promise<boolean> {
	return waitFor(
		() => agentIds.every((id) => assistantTurns(session, id) >= minTurns && !busy(session, id)),
		timeoutMs,
	)
}

function workerIds(session: Session): AgentId[] {
	const ids: AgentId[] = []
	for (const [agentId, agent] of session.state.agents) {
		if (agent.definitionName === WORKER_AGENT) ids.push(agentId)
	}
	return ids
}

async function closeQuietly(session: Session): Promise<void> {
	try {
		await session.close()
	} catch {
		// Teardown failure must not lose the measurement that preceded it.
	}
}

// ============================================================================
// Dimension: parallel agents
// ============================================================================

interface AgentRow {
	agents: number
	mode: string
	/** Run start until all N workers exist — the orchestrator's fan-out cost in fanout mode. */
	spawnMs: number
	/** …and from there until every worker has finished its turns. This is the parallel phase. */
	workersMs: number
	/** …and until every agent in the session is quiet, workers and orchestrator alike. */
	sessionIdleMs: number
	inferences: number
	/** Concurrent inferences observed inside the mock provider. */
	maxInFlight: number
	settled: boolean
	heartbeat: HeartbeatSummary
}

interface AgentsResult {
	rows: AgentRow[]
	/**
	 * The largest N against N=1. `wallGrowth` is 1 when N agents cost what one
	 * costs and N when they serialise; `serialFraction` normalises that by N, so
	 * 1/N is perfect overlap and 1.0 is a queue.
	 */
	scaling: { baselineMs: number; largestMs: number; agents: number; wallGrowth: number; serialFraction: number } | null
	notes: string[]
}

async function measureAgents(context: LimitProbeContext, iterationsPerMs: number): Promise<AgentsResult> {
	const { params } = context
	const sizes = counts(params, 'agentCounts', [1, 2, 4, 8])
	const delayMs = count(params, 'agentDelayMs', 200)
	const burnMs = count(params, 'agentBurnMs', 0)
	const turns = count(params, 'agentTurns', 1)
	const debounceMs = count(params, 'debounceMs', 50)
	const mode = text(params, 'agentMode', 'direct')
	if (mode !== 'direct' && mode !== 'fanout') throw new Error('agentMode must be direct or fanout')

	const preset = buildPreset(debounceMs)
	const rows: AgentRow[] = []

	for (const size of sizes) {
		const script = createScript({
			delayMs,
			burnIterations: Math.round(burnMs * iterationsPerMs),
			turns,
			spawnCount: mode === 'fanout' ? size : 0,
		})
		const system = systemFor(context.boot().services, preset, script.handler)
		const created = await system.sessionManager.createSession(preset.id)
		if (!created.ok) throw new Error(`createSession failed: ${JSON.stringify(created.error)}`)
		const session = created.value
		const orchestrator = session.getEntryAgentId()
		if (!orchestrator) throw new Error('session has no entry agent')

		try {
			const stopHeartbeat = startHeartbeat(20)
			const started = await now()

			if (mode === 'fanout') {
				// The orchestrator's own inference fans out; its N spawn tool calls run
				// serially inside one continue() loop before the last worker exists.
				const sent = await session.callPluginMethod('user-chat.sendMessage', {
					sessionId: String(session.id),
					content: `Start ${size} workers.`,
					agentId: String(orchestrator),
				})
				if (!sent.ok) throw new Error(`sendMessage failed: ${JSON.stringify(sent.error)}`)
			} else {
				for (let index = 0; index < size; index++) {
					const spawn = await session.spawnAgentManually(WORKER_AGENT, orchestrator, 'Do one unit of work.')
					if (!spawn.ok) throw new Error(`spawn failed: ${JSON.stringify(spawn.error)}`)
				}
			}

			const allSpawned = await waitFor(() => workerIds(session).length >= size, SETTLE_TIMEOUT_MS)
			if (!allSpawned) throw new Error(`only ${workerIds(session).length} of ${size} workers were spawned`)
			const spawnedAt = await now()
			const workers = workerIds(session)
			const settled = await waitForTurns(session, workers, turns, SETTLE_TIMEOUT_MS)
			const workersDone = await now()
			// Nothing reports back to the parent unaided, so this only catches trailing bookkeeping.
			await waitFor(() => [...session.state.agents.keys()].every((id) => !busy(session, id)), SETTLE_TIMEOUT_MS)
			const idle = await now()
			const heartbeat = stopHeartbeat()

			rows.push({
				agents: workers.length,
				mode,
				spawnMs: spawnedAt - started,
				workersMs: workersDone - spawnedAt,
				sessionIdleMs: idle - started,
				inferences: script.peak().calls,
				maxInFlight: script.peak().maxInFlight,
				settled,
				heartbeat,
			})
		} finally {
			await closeQuietly(session)
		}
	}

	const baseline = rows.find((row) => row.agents === 1)
	const largest = rows[rows.length - 1]
	const scaling = baseline && largest && largest.agents > 1 && baseline.workersMs > 0
		? {
			baselineMs: baseline.workersMs,
			largestMs: largest.workersMs,
			agents: largest.agents,
			wallGrowth: largest.workersMs / baseline.workersMs,
			serialFraction: (largest.workersMs / baseline.workersMs) / largest.agents,
		}
		: null

	return {
		rows,
		scaling,
		notes: [
			`each inference waits ${delayMs} ms and burns ${burnMs} ms of CPU; the LLM is the scripted mock, so no network is involved`,
			`agents debounce at ${debounceMs} ms, which is a floor under workersMs regardless of N`,
			'workersMs starts once all N workers exist; in fanout mode the first-spawned worker has already been running for the length of spawnMs',
			'maxInFlight is counted inside the mock provider: it is how many inferences were genuinely open at once',
			'heartbeat lateness is a 20 ms timer measured across the run — it shows how long the thread was held at a stretch',
			'a parent may hold at most 20 children (hard-coded in Session.spawnAgentManually), so N above 20 needs more than one parent',
			'in direct mode the orchestrator never infers: nothing reports back to a parent unless an agent calls send_message',
		],
	}
}

// ============================================================================
// Dimension: live sessions
// ============================================================================

interface SessionCheckpoint {
	live: number
	lastCreateMs: number
	meanCreateMs: number
	/** One full turn driven in the oldest session — does an old session slow as new ones pile up? */
	oldestTurnMs: number | null
	idleHeartbeat: HeartbeatSummary
	sqlBytes: number
	/** Directories under /workspace — every session this DO ever held, live or abandoned. */
	workspaceEntries: number
	workspaceListMs: number
	error?: string
}

interface SessionsResult {
	checkpoints: SessionCheckpoint[]
	reached: number
	stoppedBy: string
	notes: string[]
}

async function measureSessions(context: LimitProbeContext): Promise<SessionsResult> {
	const { params } = context
	const target = count(params, 'sessionMax', 32)
	const step = count(params, 'sessionStep', 8)
	const idleWindowMs = count(params, 'sessionIdleMs', 1000)
	const debounceMs = count(params, 'debounceMs', 50)
	const drive = text(params, 'sessionDrive', '1') !== '0'

	const preset = buildPreset(debounceMs)
	// One inference per turn, no spawning: this dimension measures holding cost, not fan-out.
	const script = createScript({ delayMs: 0, burnIterations: 0, turns: 1, spawnCount: 0 })
	const system = systemFor(context.boot().services, preset, script.handler)

	const sessions: Session[] = []
	const checkpoints: SessionCheckpoint[] = []
	let createTotalMs = 0
	let stoppedBy = 'target reached'

	try {
		for (let index = 0; index < target; index++) {
			let lastCreateMs = 0
			try {
				const start = await now()
				const created = await system.sessionManager.createSession(preset.id)
				lastCreateMs = (await now()) - start
				if (!created.ok) {
					stoppedBy = `createSession rejected: ${JSON.stringify(created.error)}`
					break
				}
				sessions.push(created.value)
				createTotalMs += lastCreateMs
			} catch (error) {
				stoppedBy = `createSession threw: ${describe(error)}`
				break
			}

			if (sessions.length % step !== 0 && sessions.length !== target) continue

			const stopHeartbeat = startHeartbeat(20)
			await scheduler.wait(idleWindowMs)
			const idleHeartbeat = stopHeartbeat()

			let oldestTurnMs: number | null = null
			let error: string | undefined
			const oldest = sessions[0]
			const oldestAgent = oldest.getEntryAgentId()
			if (drive && oldestAgent) {
				const before = assistantTurns(oldest, oldestAgent)
				const start = await now()
				const sent = await oldest.callPluginMethod('user-chat.sendMessage', {
					sessionId: String(oldest.id),
					content: 'ping',
					agentId: String(oldestAgent),
				})
				if (!sent.ok) {
					error = `sendMessage failed: ${JSON.stringify(sent.error)}`
				} else {
					const settled = await waitForTurns(oldest, [oldestAgent], before + 1, SETTLE_TIMEOUT_MS)
					oldestTurnMs = (await now()) - start
					if (!settled) error = 'oldest session did not settle its turn'
				}
			}

			// Session creation slowed on a DO that had already held thousands of
			// sessions, so the count that matters may be lifetime rather than live.
			const listStart = await now()
			const entries = await context.platform.fs.readdir('/workspace')
			const workspaceListMs = (await now()) - listStart

			checkpoints.push({
				live: sessions.length,
				lastCreateMs,
				meanCreateMs: createTotalMs / sessions.length,
				oldestTurnMs,
				idleHeartbeat,
				sqlBytes: context.ctx.storage.sql.databaseSize,
				workspaceEntries: entries.length,
				workspaceListMs,
				error,
			})
			if (error) {
				stoppedBy = error
				break
			}
		}
	} finally {
		// Every live session holds a 2 s git-status interval; leaving them running
		// would poison whatever runs in this DO next.
		for (const session of sessions) await closeQuietly(session)
	}

	return {
		checkpoints,
		reached: sessions.length,
		stoppedBy,
		notes: [
			'sessions are held open, never closed, until the run ends — nothing in SessionManager evicts an idle session',
			'every live session arms a 2 s git-status interval, so idle heartbeat lateness is the background cost of holding them',
			'sqlBytes is the whole DO database, event rows and workspace files together',
			'closing a session frees its timers but leaves its events and its workspace directory behind, so workspaceEntries only grows',
			`the oldest session is driven through one full turn at each checkpoint${drive ? '' : ' (disabled by sessionDrive=0)'}`,
		],
	}
}

// ============================================================================
// Dimension: concurrent shell exec
// ============================================================================

async function execSpan(workspace: Workspace, backend: string, command: string): Promise<Span> {
	const startMs = await now()
	try {
		const handle = await workspace.runtime.exec(command, { backend, encoding: 'utf8' })
		try {
			const result = await handle.result()
			const ok = result.status === 'completed' && result.exitCode === 0
			return { startMs, endMs: await now(), ok, detail: ok ? undefined : `status=${result.status} exit=${result.exitCode}` }
		} finally {
			handle[Symbol.dispose]()
		}
	} catch (error) {
		return { startMs, endMs: await now(), ok: false, detail: describe(error) }
	}
}

interface ExecRow {
	concurrent: number
	wallMs: number
	/** Slowest single exec in the batch — queueing shows up here before it shows up in wallMs. */
	slowestMs: number
	medianMs: number
	maxOverlap: number
	failures: number
	firstError?: string
	heartbeat: HeartbeatSummary
}

interface ExecResult {
	command: string
	rows: ExecRow[]
	ceiling: { largestOk: number; firstFailureAt: number | null; error?: string } | null
	notes: string[]
}

async function runExecBatch(workspace: Workspace, backend: string, command: string, concurrent: number): Promise<ExecRow> {
	const stopHeartbeat = startHeartbeat(20)
	const started = await now()
	const spans = await Promise.all(Array.from({ length: concurrent }, () => execSpan(workspace, backend, command)))
	const wallMs = (await now()) - started
	const heartbeat = stopHeartbeat()

	const durations = spans.map((span) => span.endMs - span.startMs).sort((a, b) => a - b)
	const failures = spans.filter((span) => !span.ok)
	return {
		concurrent,
		wallMs,
		slowestMs: durations[durations.length - 1],
		medianMs: durations[Math.floor(durations.length / 2)],
		maxOverlap: maxOverlap(spans),
		failures: failures.length,
		firstError: failures[0]?.detail,
		heartbeat,
	}
}

async function measureExec(context: LimitProbeContext): Promise<ExecResult> {
	const { params, workspace, backend } = context
	const sizes = counts(params, 'execCounts', [1, 2, 4, 8, 16])
	const command = text(params, 'execCmd', 'sleep 0.3')
	const ceilingMax = count(params, 'execCeiling', 0)

	const rows: ExecRow[] = []
	for (const size of sizes) rows.push(await runExecBatch(workspace, backend, command, size))

	let ceiling: ExecResult['ceiling'] = null
	if (ceilingMax > 0) {
		let largestOk = 0
		let firstFailureAt: number | null = null
		let error: string | undefined
		for (let size = 8; size <= ceilingMax; size *= 2) {
			const row = await runExecBatch(workspace, backend, command, size)
			rows.push(row)
			if (row.failures === 0) {
				largestOk = size
				continue
			}
			firstFailureAt = size
			error = row.firstError
			break
		}
		ceiling = { largestOk, firstFailureAt, error }
	}

	return {
		command,
		rows,
		ceiling,
		notes: [
			'every exec is a Dynamic Worker minted by WorkerShellBackend, which calls back into this DO for filesystem access',
			'maxOverlap counts execs alive at the same instant; wallMs near a single exec means they truly ran together',
			`the default command is a sleep, so it measures dispatch and not shell CPU — pass ?execCmd= to load the shell instead`,
		],
	}
}

// ============================================================================
// Dimension: storage gates
// ============================================================================

interface GateRow {
	workload: string
	operations: number
	wallMs: number
	perOpMs: number
	heartbeat: HeartbeatSummary
	error?: string
}

async function measureGate(context: LimitProbeContext): Promise<{ rows: GateRow[]; notes: string[] }> {
	const { params, ctx, platform } = context
	const operations = count(params, 'gateOps', 200)
	const windowMs = count(params, 'gateIdleMs', 500)

	const preset = buildPreset(count(params, 'debounceMs', 50))
	const script = createScript({ delayMs: 0, burnIterations: 0, turns: 1, spawnCount: 0 })
	const services = context.boot().services
	const system = systemFor(services, preset, script.handler)
	const created = await system.sessionManager.createSession(preset.id)
	if (!created.ok) throw new Error(`createSession failed: ${JSON.stringify(created.error)}`)
	const session = created.value
	const agentId = session.getEntryAgentId()
	if (!agentId) throw new Error('session has no entry agent')

	const rows: GateRow[] = []
	const measure = async (workload: string, run: () => Promise<void>): Promise<void> => {
		const stopHeartbeat = startHeartbeat(20)
		const started = await now()
		let error: string | undefined
		try {
			await run()
		} catch (failure) {
			error = describe(failure)
		}
		const wallMs = (await now()) - started
		rows.push({ workload, operations, wallMs, perOpMs: wallMs / operations, heartbeat: stopHeartbeat(), error })
	}

	try {
		await measure('idle', () => scheduler.wait(windowMs))

		// roj's own write path here: SqliteEventStore appends through synchronous sql.exec.
		await measure('event-append', async () => {
			for (let index = 0; index < operations; index++) {
				const event: DomainEvent = Object.assign(
					agentEvents.create('agent_state_changed', { agentId, fromState: 'pending', toState: 'inferring' }),
					{ sessionId: session.id },
				)
				await services.eventStore.append(session.id, event)
			}
		})

		// The async KV surface, which is the one the input/output gates actually apply to.
		await measure('storage-put', async () => {
			for (let index = 0; index < operations; index++) {
				await ctx.storage.put(`${GATE_KEY_PREFIX}${index}`, 'x'.repeat(1024))
			}
		})

		await measure('workspace-write', async () => {
			await platform.fs.mkdir(GATE_DIR, { recursive: true })
			for (let index = 0; index < operations; index++) {
				await platform.fs.writeFile(`${GATE_DIR}/f-${index}.txt`, 'x'.repeat(1024))
			}
		})
	} finally {
		await closeQuietly(session)
		for (let index = 0; index < operations; index++) {
			await ctx.storage.delete(`${GATE_KEY_PREFIX}${index}`)
		}
	}

	return {
		rows,
		notes: [
			'ticksPerSecond against the idle row is the whole finding: a workload that keeps it up leaves other agents free to run',
			'event-append and workspace-write reach SQLite through synchronous sql.exec, so awaiting them yields a microtask and never lets a timer through — a burst holds the isolate for its whole length',
			'storage-put is the async KV API, the only workload here a DO input/output gate can defer',
			'the idle row is the control, and on a contended box it is well under 1000/periodMs — compare rows, not absolutes',
		],
	}
}

// ============================================================================
// Probe
// ============================================================================

const ALL_DIMENSIONS = ['agents', 'sessions', 'exec', 'gate'] as const

export const concurrencyProbe: LimitProbe = async (context) => {
	const requested = text(context.params, 'dims', ALL_DIMENSIONS.join(',')).split(',')
	const unknown = requested.filter((name) => !ALL_DIMENSIONS.some((dimension) => dimension === name))
	if (unknown.length > 0) throw new Error(`unknown dims: ${unknown.join(',')} (known: ${ALL_DIMENSIONS.join(',')})`)

	const iterationsPerMs = await calibrateSpin()
	const startedAt = await now()

	const agents = requested.includes('agents') ? await measureAgents(context, iterationsPerMs) : undefined
	const sessions = requested.includes('sessions') ? await measureSessions(context) : undefined
	const exec = requested.includes('exec') ? await measureExec(context) : undefined
	const gate = requested.includes('gate') ? await measureGate(context) : undefined

	return {
		dims: requested,
		spinIterationsPerMs: Math.round(iterationsPerMs),
		agents,
		sessions,
		exec,
		gate,
		totalMs: (await now()) - startedAt,
		notes: [
			'no API key in this environment: inference is the scripted mock, so network latency is excluded and only roj scheduling is measured',
			'wrangler dev on a shared box — read every figure as indicative, and compare rows inside one run rather than across runs',
		],
	}
}
