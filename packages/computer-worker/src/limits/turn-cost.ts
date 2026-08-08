/**
 * What one agent turn costs a Worker invocation.
 *
 * Turns are driven for real — session, mailbox, plugin hooks, tool executor,
 * event store — against a scripted provider that answers in-process. There is
 * no API key in this environment, so the LLM fetch and everything it waits on
 * is excluded by construction: every millisecond below is roj's own CPU, and a
 * deployed turn pays the provider latency on top of it.
 *
 * Modes (`?mode=`):
 * - `turns` (default) — N user turns in one session, each timed on its own, so
 *   a cost that grows with session age shows up as a slope.
 * - `clock` — whether `Date.now()` runs during synchronous execution here, and
 *   what a bare `setTimeout(0)` costs. Every timing below rests on both.
 * - `invocation` — does the agent loop keep running once the invocation that
 *   started it has returned? `phase=start` sends a message and returns without
 *   waiting; `phase=check` reports what happened in between.
 */

import type { Workspace } from '@cloudflare/computer'
import {
	MockLLMProvider,
	ModelId,
	Ok,
	createOrchestrator,
	createPreset,
	createSystemFromServices,
	defineAgent,
	z,
} from '@roj-ai/sdk'
import type { AgentId, DomainEvent, LLMMessage, Preset, Result, Services, Session } from '@roj-ai/sdk'
import type { InferenceContext, InferenceRequest, InferenceResponse, LLMError, LLMProvider } from '@roj-ai/sdk/llm/provider'
import { ToolCallId, createTool } from '@roj-ai/sdk/tools'
import { withOwnScheduler } from '../own-scheduler.js'
import type { LimitProbe, LimitProbeContext } from './context.js'

/** Paid-plan CPU per invocation; `limits.cpu_ms` raises it to 300 000. */
const CPU_BUDGET_MS = 30_000

/** Subrequests per invocation on the paid plan. DO storage ops do not count. */
const SUBREQUEST_BUDGET = 1000

/** Marks the message a turn is driven by, so the script acts on it and on nothing else. */
const DRIVE_MARK = '[[drive]]'

/** Two consecutive appends of a 12-plugin session are ~1 ms apart; three settles it. */
const IDLE_STABLE_POLLS = 3

/** Ceiling on one turn before the probe gives up and reports it unsettled. */
const TURN_TIMEOUT_MS = 60_000

// ============================================================================
// Clock
// ============================================================================

/**
 * A clock reading taken after an I/O yield.
 *
 * A deployed Worker only advances `Date.now()` on I/O, so a span read across
 * synchronous work would come back as zero there. Bracketing every reading
 * with a yield makes the same measurement legible in both runtimes, at the
 * cost of the timer's own latency — which lands outside the measured span.
 * `mode=clock` measures which runtime this is rather than assuming.
 */
async function now(): Promise<number> {
	await scheduler.wait(0)
	return Date.now()
}

// ============================================================================
// Params
// ============================================================================

function num(params: URLSearchParams, name: string, fallback: number): number {
	const raw = params.get(name)
	if (raw === null) return fallback
	const value = Number(raw)
	if (!Number.isFinite(value)) throw new Error(`${name} must be a number`)
	return value
}

function list(params: URLSearchParams, name: string, fallback: number[]): number[] {
	const raw = params.get(name)
	if (raw === null) return fallback
	const values = raw.split(',').map(Number)
	if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
		throw new Error(`${name} must be non-negative integers`)
	}
	return values
}

// ============================================================================
// Scripted provider
// ============================================================================

interface Script {
	/** Tool calls the acting agent emits per driving message. */
	toolCalls: number
	/** Bytes each tool result carries back into history. */
	resultBytes: number
	/** Children the entry agent spawns per driving message. */
	children: number
}

/**
 * What one inference was handed.
 *
 * The prompt is kept by reference and only sized once the turn is over:
 * measuring it inline would add an O(history) `JSON.stringify` to every
 * inference and manufacture exactly the growth this probe is looking for.
 */
interface InferenceRecord {
	agentId: string
	messages: readonly LLMMessage[]
	systemPrompt: string
	toolsOffered: number
}

function promptBytes(record: InferenceRecord): number {
	return JSON.stringify(record.messages).length + record.systemPrompt.length
}

/** Ephemeral suffix the agent appends per inference; not part of the turn's own tail. */
function isEphemeral(message: LLMMessage): boolean {
	return message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<session-context>')
}

/** Last message the script decides on — the tool result, or the message that arrived. */
function tailMessage(messages: readonly LLMMessage[]): LLMMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (message.role === 'system' || isEphemeral(message)) continue
		return message
	}
	return undefined
}

function carriesMark(message: LLMMessage | undefined): boolean {
	if (message === undefined) return false
	const content = message.content
	return typeof content === 'string' && content.includes(DRIVE_MARK)
}

/**
 * Deterministic stand-in for the model.
 *
 * One driving message produces one tool round: the arriving message gets tool
 * calls, the tool results that come back get a plain stop. Anything else — a
 * child's completion report reaching its parent — gets a stop too, so a turn
 * terminates instead of feeding itself.
 */
class ScriptedProvider implements LLMProvider {
	readonly name = 'mock'
	readonly calls: InferenceRecord[] = []
	#entryAgentId: string | null = null
	#seq = 0

	constructor(private readonly script: Script) {}

	/** The entry agent fans out to children; every other agent runs the tool round. */
	setEntryAgent(agentId: AgentId | null): void {
		this.#entryAgentId = agentId === null ? null : String(agentId)
	}

	async inference(request: InferenceRequest, context?: InferenceContext): Promise<Result<InferenceResponse, LLMError>> {
		const agentId = context?.agentId ?? 'unknown'
		this.calls.push({
			agentId,
			messages: request.messages,
			systemPrompt: request.systemPrompt,
			toolsOffered: request.tools?.length ?? 0,
		})

		const metrics = MockLLMProvider.defaultMetrics()
		const tail = tailMessage(request.messages)
		if (!carriesMark(tail)) {
			return Ok({ content: 'Done.', toolCalls: [], finishReason: 'stop', metrics })
		}

		const isEntry = agentId === this.#entryAgentId
		if (isEntry && this.script.children > 0) {
			return Ok({
				content: 'Fanning out.',
				toolCalls: Array.from({ length: this.script.children }, () =>
					this.#call('start_worker', { message: `${DRIVE_MARK} run one step` })),
				finishReason: 'tool_calls',
				metrics,
			})
		}

		return Ok({
			content: 'Working.',
			toolCalls: Array.from({ length: this.script.toolCalls }, () =>
				this.#call('bench_step', { bytes: this.script.resultBytes })),
			finishReason: 'tool_calls',
			metrics,
		})
	}

	#call(name: string, input: unknown) {
		this.#seq += 1
		return { id: ToolCallId(`turn-cost-${this.#seq}`), name, input }
	}
}

// ============================================================================
// Preset
// ============================================================================

interface PresetOptions {
	workspace: Workspace
	backend: string
	/** Shell execs the tool runs per call — each one is a Dynamic Worker round trip. */
	execPerCall: number
	debounceMs: number
	onExec: () => void
}

/**
 * Two agents, one tool. The tool returns a payload of the requested size and
 * optionally shells out, which is the only thing in a turn that leaves the DO.
 */
function buildPreset(options: PresetOptions): Preset {
	const step = createTool({
		name: 'bench_step',
		description: 'Return a payload of the requested size.',
		input: z.object({ bytes: z.number() }),
		execute: async (input) => {
			for (let index = 0; index < options.execPerCall; index++) {
				options.onExec()
				const handle = await options.workspace.runtime.exec('echo step', { backend: options.backend, encoding: 'utf8' })
				try {
					await handle.result()
				} finally {
					handle[Symbol.dispose]()
				}
			}
			return { ok: true, value: 'x'.repeat(Math.max(0, input.bytes)) }
		},
	})

	const worker = defineAgent({
		name: 'worker',
		system: 'You call bench_step once per instruction.',
		model: ModelId('mock/model'),
		debounceMs: options.debounceMs,
		tools: [step],
		agents: [],
	})

	return createPreset({
		id: 'turn-cost',
		name: 'Turn cost probe',
		workspaceDir: '/workspace/{sessionId}',
		// Relative agent paths would resolve against process.cwd(), which the isolate lacks.
		sandboxed: true,
		orchestrator: createOrchestrator({
			system: 'You call bench_step, or fan work out to worker agents.',
			model: ModelId('mock/model'),
			debounceMs: options.debounceMs,
			tools: [step],
			agents: [worker],
		}),
	})
}

// ============================================================================
// Session driving
// ============================================================================

/** Sized after the fact, for the same reason as {@link InferenceRecord}. */
interface EventRecord {
	at: number
	event: DomainEvent
}

function isIdle(session: Session): boolean {
	for (const [agentId] of session.state.agents) {
		const agent = session.getAgent(agentId)
		const state = agent?.state
		if (!agent || !state) continue
		const busy = state.status !== 'pending'
			|| state.pendingToolCalls.length > 0
			|| state.pendingToolResults.length > 0
			|| agent.isScheduled()
		if (busy) return false
	}
	return true
}

/**
 * Wait until every agent is quiet. Polls at 1 ms and wants the same answer
 * three times running, because an agent is briefly indistinguishable from idle
 * between the event that finishes a step and the timer that starts the next.
 */
async function waitForIdle(session: Session): Promise<boolean> {
	const deadline = Date.now() + TURN_TIMEOUT_MS
	let stable = 0
	while (Date.now() < deadline) {
		stable = isIdle(session) ? stable + 1 : 0
		if (stable >= IDLE_STABLE_POLLS) return true
		await scheduler.wait(1)
	}
	return false
}

function historySize(session: Session): { messages: number; bytes: number; agents: number } {
	let messages = 0
	let bytes = 0
	for (const agent of session.state.agents.values()) {
		messages += agent.conversationHistory.length
		bytes += JSON.stringify(agent.conversationHistory).length
	}
	return { messages, bytes, agents: session.state.agents.size }
}

// ============================================================================
// Turn measurement
// ============================================================================

interface TurnRow {
	turn: number
	/** Send → last event of the turn. The settle poll is excluded, so this is the work itself. */
	spanMs: number
	/** Send → idle confirmed, which carries the settle poll on top of spanMs. */
	wallMs: number
	/** spanMs with the debounce waits taken out — the turn's actual work. See {@link workWithin}. */
	workMs: number
	events: number
	eventBytes: number
	inferences: number
	promptBytes: number
	execs: number
	historyMessages: number
	historyBytes: number
	agents: number
	settled: boolean
}

interface CombinationResult {
	resultBytes: number
	children: number
	toolCalls: number
	execPerCall: number
	rows: TurnRow[]
	/** Event-by-event breakdown of the last turn — where inside a turn the time goes. */
	lastTurnTimeline: { type: string; atMs: number; deltaMs: number; bytes: number }[]
	/** Least-squares slope of workMs over turn index — the growth the replay bench predicts. */
	growthMsPerTurn: number
	firstTurnMs: number
	lastTurnMs: number
	meanTurnMs: number
	/** Mean workMs — what the budget projections below are spent against. */
	meanWorkMs: number
	storedRows: number
	storedBytes: number
	eventTypes: Record<string, number>
	subrequests: {
		llmInferences: number
		shellExecs: number
		globalFetches: number
		perTurnBillable: number
	}
	/** 30 s divided by the mean work per turn — right only if turn cost is flat. */
	turnsPerCpuBudget: number
	/** Same budget, spent against a turn that costs `growthMsPerTurn` more each time. */
	turnsPerCpuBudgetWithGrowth: number
	turnsPerSubrequestBudget: number
}

/**
 * Turns that fit in the CPU budget when each one costs `slope` ms more than the
 * last: solve `first·N + slope·N(N−1)/2 = budget`. An extrapolation of a fit
 * taken over a handful of turns — indicative, not a promise.
 */
function turnsUntilBudget(first: number, mean: number, slope: number, budgetMs: number): number {
	// No growth to project: the mean is a better baseline than turn 1, which pays
	// the cold cost of building the session's agents and prompts.
	if (slope <= 0) return mean > 0 ? Math.floor(budgetMs / mean) : 0
	if (first <= 0) return 0
	const b = first - slope / 2
	return Math.floor((-b + Math.sqrt(b * b + 2 * slope * budgetMs)) / slope)
}

/**
 * The work inside a turn, with the scheduling waits removed.
 *
 * Every gap between two events is either work or an agent sitting on its
 * debounce timer, and a gap that reaches `debounceMs` is one of the latter with
 * the work tacked on its end. Subtracting the timer from those gaps leaves the
 * turn's own cost. At `debounceMs=0` nothing can be subtracted, and what
 * remains also carries the DO's storage-commit wait, which a debounce longer
 * than the commit otherwise hides.
 */
function workWithin(records: readonly EventRecord[], from: number, debounceMs: number): number {
	let total = 0
	let previous = from
	for (const record of records) {
		const gap = record.at - previous
		total += debounceMs > 0 && gap >= debounceMs ? gap - debounceMs : gap
		previous = record.at
	}
	return total
}

function slope(rows: readonly TurnRow[]): number {
	if (rows.length < 2) return 0
	const n = rows.length
	const meanX = (n - 1) / 2
	const meanY = rows.reduce((sum, row) => sum + row.workMs, 0) / n
	let numerator = 0
	let denominator = 0
	rows.forEach((row, index) => {
		numerator += (index - meanX) * (row.workMs - meanY)
		denominator += (index - meanX) ** 2
	})
	return denominator === 0 ? 0 : numerator / denominator
}

interface RunOptions {
	context: LimitProbeContext
	services: Services<'isolate'>
	turns: number
	resultBytes: number
	children: number
	toolCalls: number
	execPerCall: number
	debounceMs: number
}

async function runCombination(options: RunOptions): Promise<CombinationResult> {
	const { context, services, turns } = options
	let execs = 0
	const preset = buildPreset({
		workspace: context.workspace,
		backend: context.backend,
		execPerCall: options.execPerCall,
		debounceMs: options.debounceMs,
		onExec: () => {
			execs += 1
		},
	})

	const provider = new ScriptedProvider({
		toolCalls: options.toolCalls,
		resultBytes: options.resultBytes,
		children: options.children,
	})
	const system = createSystemFromServices({
		...withOwnScheduler(services),
		presets: new Map([[preset.id, preset]]),
		llmProvider: provider,
		llmProviders: new Map([['mock', provider]]),
	})

	const created = await system.sessionManager.createSession(preset.id)
	if (!created.ok) throw new Error(`createSession failed: ${JSON.stringify(created.error)}`)
	const session = created.value
	const entryAgentId = session.getEntryAgentId()
	if (!entryAgentId) throw new Error('session has no entry agent')
	provider.setEntryAgent(entryAgentId)

	const events: EventRecord[] = []
	const unsubscribe = session.store.onEvent((event) => {
		events.push({ at: Date.now(), event })
	})

	const globalFetches: string[] = []
	const restoreFetch = countFetches(globalFetches)

	const rows: TurnRow[] = []
	let lastTurnEvents: EventRecord[] = []
	let lastTurnStart = 0
	try {
		for (let turn = 1; turn <= turns; turn++) {
			const eventMark = events.length
			const inferenceMark = provider.calls.length
			const execMark = execs

			const started = await now()
			const sent = await session.callPluginMethod('user-chat.sendMessage', {
				sessionId: String(session.id),
				content: `${DRIVE_MARK} turn ${turn}`,
				agentId: String(entryAgentId),
			})
			if (!sent.ok) throw new Error(`sendMessage failed: ${JSON.stringify(sent.error)}`)

			const settled = await waitForIdle(session)
			const wallEnd = await now()

			const turnEvents = events.slice(eventMark)
			const turnCalls = provider.calls.slice(inferenceMark)
			const history = historySize(session)
			lastTurnEvents = turnEvents
			lastTurnStart = started
			rows.push({
				turn,
				spanMs: (turnEvents[turnEvents.length - 1]?.at ?? wallEnd) - started,
				wallMs: wallEnd - started,
				workMs: workWithin(turnEvents, started, options.debounceMs),
				events: turnEvents.length,
				eventBytes: turnEvents.reduce((sum, record) => sum + JSON.stringify(record.event).length, 0),
				inferences: turnCalls.length,
				promptBytes: turnCalls.reduce((sum, call) => sum + promptBytes(call), 0),
				execs: execs - execMark,
				historyMessages: history.messages,
				historyBytes: history.bytes,
				agents: history.agents,
				settled,
			})
		}
	} finally {
		restoreFetch()
		unsubscribe()
		await session.close()
		// close() emits; the hooks that stop git-status polling and shut the agents
		// down run off that event, so give them a tick before the next combination.
		await scheduler.wait(0)
	}

	const eventTypes: Record<string, number> = {}
	for (const record of events) eventTypes[record.event.type] = (eventTypes[record.event.type] ?? 0) + 1

	const stored = storedFor(context, String(session.id))
	const meanTurnMs = rows.reduce((sum, row) => sum + row.spanMs, 0) / Math.max(1, rows.length)
	const meanWorkMs = rows.reduce((sum, row) => sum + row.workMs, 0) / Math.max(1, rows.length)
	const perTurnBillable = (provider.calls.length + execs) / Math.max(1, rows.length)
	const growthMsPerTurn = slope(rows)

	return {
		resultBytes: options.resultBytes,
		children: options.children,
		toolCalls: options.toolCalls,
		execPerCall: options.execPerCall,
		rows,
		lastTurnTimeline: lastTurnEvents.map((record, index) => ({
			type: record.event.type,
			atMs: record.at - lastTurnStart,
			deltaMs: record.at - (lastTurnEvents[index - 1]?.at ?? lastTurnStart),
			bytes: JSON.stringify(record.event).length,
		})),
		growthMsPerTurn,
		firstTurnMs: rows[0]?.spanMs ?? 0,
		lastTurnMs: rows[rows.length - 1]?.spanMs ?? 0,
		meanTurnMs,
		meanWorkMs,
		storedRows: stored.rows,
		storedBytes: stored.bytes,
		eventTypes,
		subrequests: {
			llmInferences: provider.calls.length,
			shellExecs: execs,
			globalFetches: globalFetches.length,
			perTurnBillable,
		},
		turnsPerCpuBudget: meanWorkMs > 0 ? Math.floor(CPU_BUDGET_MS / meanWorkMs) : 0,
		turnsPerCpuBudgetWithGrowth: turnsUntilBudget(rows[0]?.workMs ?? 0, meanWorkMs, growthMsPerTurn, CPU_BUDGET_MS),
		turnsPerSubrequestBudget: perTurnBillable > 0 ? Math.floor(SUBREQUEST_BUDGET / perTurnBillable) : 0,
	}
}

/**
 * Count every `fetch` the isolate issues while a run is in flight.
 *
 * Under the scripted provider this must stay at zero: it is the control that
 * says the LLM call is the only fetch a turn makes, and that nothing under the
 * SDK or the workspace quietly issues another.
 */
function countFetches(sink: string[]): () => void {
	const original = globalThis.fetch
	const counting: typeof globalThis.fetch = (input, init) => {
		sink.push(input instanceof Request ? input.url : String(input))
		return original(input, init)
	}
	try {
		globalThis.fetch = counting
	} catch {
		// A runtime that seals the global leaves the count at zero; say so rather than fail.
		sink.push('fetch is not patchable in this runtime — count unavailable')
		return () => {}
	}
	return () => {
		globalThis.fetch = original
	}
}

function storedFor(context: LimitProbeContext, sessionId: string): { rows: number; bytes: number } {
	const summary = context.ctx.storage.sql
		.exec<{ event_rows: number; payload_bytes: number | null }>(
			'SELECT COUNT(*) AS event_rows, SUM(LENGTH(payload)) AS payload_bytes FROM roj_events WHERE session_id = ?',
			sessionId,
		)
		.toArray()[0]
	return { rows: summary?.event_rows ?? 0, bytes: summary?.payload_bytes ?? 0 }
}

// ============================================================================
// mode=clock
// ============================================================================

/** Enough arithmetic to be unmistakable if the clock is running. */
function burn(iterations: number): number {
	let acc = 0
	for (let index = 0; index < iterations; index++) acc += Math.sqrt(index)
	return acc
}

/**
 * Latency of a bare `setTimeout(0)`.
 *
 * A turn crosses three of these — schedule, tool re-entry, next inference — and
 * they are wall time the isolate spends waiting, not CPU it burns. Without this
 * floor a per-turn span reads as far more work than it is.
 */
async function timerFloor(hops: number): Promise<{ hops: number; meanMs: number; minMs: number; maxMs: number }> {
	const samples: number[] = []
	for (let index = 0; index < hops; index++) {
		const before = Date.now()
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0)
		})
		samples.push(Date.now() - before)
	}
	return {
		hops,
		meanMs: samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length),
		minMs: Math.min(...samples),
		maxMs: Math.max(...samples),
	}
}

async function clockMode(params: URLSearchParams): Promise<unknown> {
	const iterations = num(params, 'iterations', 20_000_000)

	const beforeSync = Date.now()
	const checksum = burn(iterations)
	const afterSync = Date.now()

	await Promise.resolve()
	const afterMicrotask = Date.now()

	await scheduler.wait(0)
	const afterTimer = Date.now()

	const perfBefore = performance.now()
	burn(iterations)
	const perfAfter = performance.now()

	return {
		iterations,
		checksum,
		dateNow: {
			acrossSyncBurnMs: afterSync - beforeSync,
			acrossMicrotaskMs: afterMicrotask - afterSync,
			acrossTimerYieldMs: afterTimer - afterMicrotask,
		},
		performanceNow: { acrossSyncBurnMs: perfAfter - perfBefore },
		timerFloor: await timerFloor(num(params, 'hops', 50)),
		notes: [
			'acrossSyncBurnMs 0 means the clock is frozen during synchronous execution — the documented Worker behaviour — and every span must be bracketed by an I/O yield to be readable',
			'a non-zero acrossSyncBurnMs means this runtime lets the clock run, so timings here are wall time and would not be readable the same way on a deployed Worker',
			'acrossTimerYieldMs is the whole frozen span released at once, so it carries the burn plus the timer',
			'timerFloor is what a bare setTimeout(0) costs here; a turn crosses three, so subtract 3× meanMs from a turn span before reading it as CPU',
		],
	}
}

// ============================================================================
// mode=invocation
// ============================================================================

interface InvocationRun {
	startedAt: number
	returnedAt: number
	eventsAtReturn: number
	inferencesAtReturn: number
	idleAtReturn: boolean
	/** Clock readings from a self-rescheduling timer armed inside the start invocation. */
	ticks: number[]
	events: EventRecord[]
	inferences: () => number
	/** When every agent first went quiet, or null if the loop never got there. */
	idleAt: () => number | null
	session: Session
	stop: () => void
}

let invocationRun: InvocationRun | null = null

/** Close whatever an earlier `phase=start` left running, so it cannot skew a later run. */
async function stopInvocationRun(): Promise<void> {
	const run = invocationRun
	if (!run) return
	invocationRun = null
	run.stop()
	await run.session.close()
	await scheduler.wait(0)
}

/** Ticks spaced far enough apart that surviving them means surviving the invocation. */
const TICK_INTERVAL_MS = 25
const MAX_TICKS = 200

async function invocationStart(context: LimitProbeContext, services: Services<'isolate'>, params: URLSearchParams): Promise<unknown> {
	await stopInvocationRun()

	// Several tool calls, so the turn is long enough to still be running at the return.
	const toolCalls = num(params, 'toolCalls', 3)
	let execs = 0
	const preset = buildPreset({
		workspace: context.workspace,
		backend: context.backend,
		execPerCall: num(params, 'exec', 0),
		debounceMs: num(params, 'debounceMs', 0),
		onExec: () => {
			execs += 1
		},
	})
	const provider = new ScriptedProvider({ toolCalls, resultBytes: num(params, 'resultBytes', 512), children: num(params, 'agents', 0) })
	const system = createSystemFromServices({
		...withOwnScheduler(services),
		presets: new Map([[preset.id, preset]]),
		llmProvider: provider,
		llmProviders: new Map([['mock', provider]]),
	})

	const created = await system.sessionManager.createSession(preset.id)
	if (!created.ok) throw new Error(`createSession failed: ${JSON.stringify(created.error)}`)
	const session = created.value
	const entryAgentId = session.getEntryAgentId()
	if (!entryAgentId) throw new Error('session has no entry agent')
	provider.setEntryAgent(entryAgentId)

	const events: EventRecord[] = []
	const unsubscribe = session.store.onEvent((event) => {
		events.push({ at: Date.now(), event })
	})

	const startedAt = await now()
	const ticks: number[] = []
	let idleAt: number | null = null
	let stopped = false
	let timer: ReturnType<typeof setTimeout> | undefined

	// A self-rescheduling timer armed inside this invocation. Whether it keeps
	// firing after the response is returned is the whole question.
	const tick = () => {
		if (stopped) return
		ticks.push(Date.now())
		if (idleAt === null && isIdle(session)) idleAt = Date.now()
		if (ticks.length >= MAX_TICKS) return
		timer = setTimeout(tick, TICK_INTERVAL_MS)
	}
	timer = setTimeout(tick, TICK_INTERVAL_MS)

	const run: InvocationRun = {
		startedAt,
		returnedAt: startedAt,
		eventsAtReturn: 0,
		inferencesAtReturn: 0,
		idleAtReturn: false,
		ticks,
		events,
		inferences: () => provider.calls.length,
		idleAt: () => idleAt,
		session,
		stop: () => {
			stopped = true
			if (timer !== undefined) clearTimeout(timer)
			unsubscribe()
		},
	}

	const sent = await session.callPluginMethod('user-chat.sendMessage', {
		sessionId: String(session.id),
		content: `${DRIVE_MARK} invocation probe`,
		agentId: String(entryAgentId),
	})
	if (!sent.ok) throw new Error(`sendMessage failed: ${JSON.stringify(sent.error)}`)

	// Deliberately no wait for idle: the invocation returns with the loop mid-flight.
	run.returnedAt = Date.now()
	run.eventsAtReturn = events.length
	run.inferencesAtReturn = provider.calls.length
	run.idleAtReturn = isIdle(session)
	invocationRun = run

	return {
		phase: 'start',
		sessionId: String(session.id),
		atReturn: {
			elapsedMs: run.returnedAt - run.startedAt,
			events: run.eventsAtReturn,
			inferences: run.inferencesAtReturn,
			execs,
			idle: run.idleAtReturn,
			ticks: run.ticks.length,
		},
		next: 'call again with ?mode=invocation&phase=check after a second or two',
	}
}

function invocationCheck(): unknown {
	const run = invocationRun
	if (!run) return { phase: 'check', error: 'no run started — call ?mode=invocation&phase=start first' }

	const after = run.events.filter((record) => record.at > run.returnedAt)
	const ticksAfter = run.ticks.filter((at) => at > run.returnedAt)
	const idleAt = run.idleAt()
	const eventTypes: Record<string, number> = {}
	for (const record of after) eventTypes[record.event.type] = (eventTypes[record.event.type] ?? 0) + 1

	return {
		phase: 'check',
		sinceReturnMs: Date.now() - run.returnedAt,
		atReturn: {
			events: run.eventsAtReturn,
			inferences: run.inferencesAtReturn,
			idle: run.idleAtReturn,
		},
		sinceReturn: {
			events: after.length,
			eventTypes,
			inferences: run.inferences() - run.inferencesAtReturn,
			timerTicks: ticksAfter.length,
			lastTickAfterReturnMs: ticksAfter.length === 0 ? null : ticksAfter[ticksAfter.length - 1] - run.returnedAt,
			reachedIdle: idleAt !== null,
			idleAfterReturnMs: idleAt === null ? null : idleAt - run.returnedAt,
		},
		reading: [
			'events and inferences after the return mean the agent loop is not confined to the invocation that started it — it runs off setTimeout in the DO isolate',
			'timerTicks after the return mean the isolate keeps servicing timers with no request in flight, which is what the loop is built on',
			'zero of both would mean the loop only advances while an invocation holds it open, and a caller must await idle',
		],
	}
}

// ============================================================================
// Probe
// ============================================================================

export const turnCostProbe: LimitProbe = async (context) => {
	const { params } = context
	const mode = params.get('mode') ?? 'turns'

	if (mode === 'clock') return clockMode(params)

	const { services } = context.boot()

	if (mode === 'invocation') {
		const phase = params.get('phase') ?? 'start'
		if (phase === 'check') return invocationCheck()
		if (phase === 'stop') {
			await stopInvocationRun()
			return { phase: 'stop', stopped: true }
		}
		if (phase !== 'start') throw new Error("phase must be 'start', 'check' or 'stop'")
		return invocationStart(context, services, params)
	}

	if (mode !== 'turns') throw new Error(`unknown mode '${mode}' — turns, clock or invocation`)

	// A session left open by an earlier invocation run would keep polling git-status
	// and land its own events in the middle of these measurements.
	await stopInvocationRun()

	const turns = num(params, 'turns', 8)
	const toolCalls = num(params, 'toolCalls', 1)
	const execPerCall = num(params, 'exec', 0)
	// Long enough to hide the DO's storage commit behind the timer, so workMs
	// reads as CPU; short enough that a sweep still finishes in seconds.
	const debounceMs = num(params, 'debounceMs', 50)
	const resultBytesList = list(params, 'resultBytes', [512])
	const agentsList = list(params, 'agents', [0])

	const combinations: CombinationResult[] = []
	const startedAt = await now()
	for (const children of agentsList) {
		for (const resultBytes of resultBytesList) {
			combinations.push(await runCombination({
				context,
				services,
				turns,
				resultBytes,
				children,
				toolCalls,
				execPerCall,
				debounceMs,
			}))
		}
	}

	return {
		mode: 'turns',
		params: { turns, toolCalls, execPerCall, debounceMs, resultBytes: resultBytesList, agents: agentsList },
		budgets: { cpuMs: CPU_BUDGET_MS, cpuMsRaisable: 300_000, subrequests: SUBREQUEST_BUDGET },
		totalMs: (await now()) - startedAt,
		combinations,
		notes: [
			'the LLM answers in-process, so no turn here pays network — these are roj-side CPU costs only, and a deployed turn adds one round trip per inference',
			'one driving message is one turn: an inference that emits tool calls, the tool executions, and the inference that consumes their results',
			'spanMs is send → last event of the turn; wallMs adds the idle-settle poll, which is measurement overhead, not turn cost',
			`debounceMs=${debounceMs} — the preset default is 500 ms, paid twice per turn; that is wall time the agent waits on a timer, not CPU it burns`,
			'workMs is spanMs with those waits subtracted, and is the figure the budget projections use; run at debounceMs≥50 to read it as CPU, because at 0 the DO storage commit is no longer hidden behind the timer and lands in workMs instead',
			'growthMsPerTurn is the least-squares slope of workMs over the turn index: the per-turn share of the reducer copying conversationHistory whole',
			'perTurnBillable counts one subrequest per inference (the LLM fetch a real provider issues) plus one per shell exec (the RPC into the Dynamic Worker); DO storage is not a subrequest',
			'globalFetches counts fetch() calls the isolate actually made — zero confirms the scripted provider issues none and nothing else does either',
			'a failing provider multiplies that: withLLMRetry allows 5 attempts and the empty-response loop calls it up to 3 times, so one inference can reach 15 fetches',
			'neither limit is enforced by wrangler dev; turnsPerCpuBudget and turnsPerSubrequestBudget compare consumption to the documented ceiling',
		],
	}
}
