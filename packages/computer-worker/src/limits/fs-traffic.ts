/**
 * What roj writes through `platform.fs` while a session runs.
 *
 * The event log already left the filesystem — `SqliteEventStore` put it in the
 * DO's own SQLite. The question this probe answers is what is left: which paths
 * the isolate profile touches during a real turn, how many operations and bytes
 * each one costs, and what one operation is worth against the alternatives (a
 * VFS append, a VFS whole-file write, a bare SQL insert).
 *
 * Nothing here infers. The census *is* the `FileSystem` the SDK boots on: the
 * probe wraps `platform.fs` before `boot()`, so every call the composition root
 * hands out — `SessionFileStore`, `FileLogger`, the filesystem plugin, the tools
 * — goes through it and is counted with its path and its byte count.
 *
 * Three phases, in order:
 *
 * - **turn** — one real two-agent turn on the DO's own SessionManager, i.e. the
 *   alarm scheduler, which is what this host actually runs. The session log is
 *   additionally tallied by its JSON `level`/`message`, so the traffic can be
 *   read as "what is being logged", not just "how much" — off the appends on a
 *   host that writes a file, and off the rows on one with `platform.sessionLog`,
 *   which this DO has. On that host the log costs no `platform.fs` call at all;
 *   `turn.sessionLog.store` is where it went.
 * - **cost** — per-operation calibration. workerd freezes `Date.now()` between
 *   I/O, so nothing here times a single call: each figure is a loop of N
 *   operations bracketed by scheduler yields and divided, the way `/bench` and
 *   `/git?rounds=` already measure.
 * - **llm** — the call log the mocked provider hides. `bootstrap` skips
 *   `LLMLogger` entirely when `config.llmMock` is set, so nothing here writes it
 *   by default. This phase constructs the logger itself and runs the same turn
 *   through it twice: once with the files it has always written and once with
 *   `platform.llmCallLog`, so the before and the after are two measurements on
 *   one box rather than a projection. Its provider also records the exact
 *   `InferenceRequest` the SDK built, which sizes what is being stored. Each arm
 *   builds its own manager, so it runs on a `LiveScheduler` — a Bun-shaped host —
 *   and its traffic is reported separately for that reason.
 *
 * `?ab=N` adds an A/B: N rounds, each running one turn in a fresh session with
 * the `session.log` writes suppressed at the adapter and one with them, as a
 * check on the projection the cost phase multiplies out. Debounce dominates a
 * turn's wall time, so read it as a check on the sign, not as the measurement.
 * It suppresses at the *filesystem*, so on a host with `platform.sessionLog`
 * there is nothing left for it to suppress and both arms are the same turn.
 */

import { LLMLogger, LoggingLLMProvider, SessionId, createSystemFromServices } from '@roj-ai/sdk'
import type { Result, Services, Session } from '@roj-ai/sdk'
import type { InferenceContext, InferenceRequest, InferenceResponse, LLMError, LLMProvider } from '@roj-ai/sdk/llm/provider'
import type { Dirent, FileSystem, ReadableFileHandle, Stats } from '@roj-ai/sdk/platform'
import { withOwnScheduler } from '../own-scheduler.js'
import { isolatePreset } from '../preset.js'
import type { Booted, LimitProbe, LimitProbeContext } from './context.js'

/** Scratch root for the cost phase; outside `/data/sessions` so it never joins the census. */
const COST_DIR = '/data/.fs-traffic'

/** Operations per calibration loop — enough that the yielded clock resolves the mean. */
const COST_OPS = 200

/** Log-line size the append calibration uses when the turn produced no lines to measure. */
const FALLBACK_LINE_BYTES = 200

const SETTLE_TIMEOUT_MS = 20_000

// ============================================================================
// Census
// ============================================================================

type FsOp =
	| 'readFile'
	| 'writeFile'
	| 'appendFile'
	| 'mkdir'
	| 'readdir'
	| 'stat'
	| 'access'
	| 'unlink'
	| 'rm'
	| 'cp'
	| 'open'
	| 'exists'
	| 'realpath'
	| 'walk'
	| 'readFiles'
	| 'writeFiles'
	| 'rmFiles'

/** Path classes, in the order they are tested. */
const CLASSES: readonly { name: string; match: RegExp }[] = [
	{ name: 'session.log', match: /^\/data\/sessions\/[^/]+\/session\.log$/ },
	{ name: 'llm call log', match: /^\/data\/sessions\/[^/]+\/calls(\/|$)/ },
	{ name: 'event log (jsonl)', match: /^\/data\/sessions\/[^/]+\/\.events(\/|$)/ },
	{ name: 'session data dir', match: /^\/data\/sessions(\/|$)/ },
	{ name: 'data root', match: /^\/data(\/|$)/ },
	{ name: 'workspace (agent output)', match: /^\/workspace(\/|$)/ },
]

function classify(path: string): string {
	for (const entry of CLASSES) {
		if (entry.match.test(path)) return entry.name
	}
	return 'other'
}

/**
 * The binary value the fs port carries.
 *
 * Read off the port rather than written as `Buffer`: this package types against
 * `@cloudflare/workers-types` alone and has no `node:` globals to name.
 */
type FsBytes = Parameters<ReadableFileHandle['read']>[0]

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

function byteLength(data: string | Uint8Array): number {
	return typeof data === 'string' ? ENCODER.encode(data).byteLength : data.byteLength
}

interface OpTally {
	pathClass: string
	op: FsOp
	count: number
	bytes: number
	maxBytes: number
}

/**
 * Counters the wrapped `FileSystem` writes into.
 *
 * `suppressed` is what the A/B arm needs: a class whose writes are dropped
 * before they reach the provider, so the same turn runs without them.
 */
class FsCensus {
	readonly tallies = new Map<string, OpTally>()
	/** Distinct paths seen per class, capped — a session's log is one path, a workspace is many. */
	readonly paths = new Map<string, Set<string>>()
	/** `session.log` lines by level and message, which says what the volume actually is. */
	readonly logLines = new Map<string, number>()
	suppressed: string | null = null
	/** Off for the A/B arms, whose wall time must not carry the tally's own JSON.parse. */
	inspectLogLines = true

	record(op: FsOp, path: string, bytes: number): void {
		const pathClass = classify(path)
		const key = `${pathClass} ${op}`
		const tally = this.tallies.get(key)
		if (tally === undefined) {
			this.tallies.set(key, { pathClass, op, count: 1, bytes, maxBytes: bytes })
		} else {
			tally.count += 1
			tally.bytes += bytes
			tally.maxBytes = Math.max(tally.maxBytes, bytes)
		}

		let seen = this.paths.get(pathClass)
		if (seen === undefined) {
			seen = new Set()
			this.paths.set(pathClass, seen)
		}
		if (seen.size < 20) seen.add(path)
	}

	/** True when this write must not reach the provider — the A/B arm's suppression. */
	drops(path: string): boolean {
		return this.suppressed !== null && classify(path) === this.suppressed
	}

	/** Tally one appended `session.log` payload by what it says. */
	inspect(path: string, data: string | Uint8Array): void {
		if (!this.inspectLogLines || classify(path) !== 'session.log') return
		const text = typeof data === 'string' ? data : DECODER.decode(data)
		for (const line of text.split('\n')) {
			if (line.length === 0) continue
			const key = describeLogLine(line)
			this.logLines.set(key, (this.logLines.get(key) ?? 0) + 1)
		}
	}

	reset(): void {
		this.tallies.clear()
		this.paths.clear()
		this.logLines.clear()
	}
}

/** `FileLogger` writes one JSON object per line; anything else is reported verbatim. */
function describeLogLine(line: string): string {
	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch {
		return 'unparsed line'
	}
	if (typeof parsed !== 'object' || parsed === null) return 'unparsed line'
	const level = 'level' in parsed && typeof parsed.level === 'string' ? parsed.level : '?'
	const message = 'message' in parsed && typeof parsed.message === 'string' ? parsed.message : '?'
	return `${level}: ${message}`
}

/**
 * The `FileSystem` the SDK boots on, counting every call.
 *
 * A class rather than an object literal because `readFile` and `readdir` are
 * overloaded: only a declared overload pair satisfies the port without a cast.
 */
class CountingFileSystem implements FileSystem {
	/**
	 * The port's optional verbs, forwarded only where the platform has them.
	 *
	 * Properties rather than methods, because a method would exist here whether
	 * or not the platform behind it does — and a caller's `if (fs.walk)` would
	 * then take a path the platform cannot serve. Each records what the loop it
	 * replaces would have recorded, one entry per path, so the census still
	 * reads as traffic per path class rather than as calls.
	 */
	readonly walk?: FileSystem['walk']
	readonly readFiles?: FileSystem['readFiles']
	readonly writeFiles?: FileSystem['writeFiles']
	readonly rmFiles?: FileSystem['rmFiles']
	readonly scopeReads?: FileSystem['scopeReads']

	constructor(private readonly inner: FileSystem, private readonly census: FsCensus) {
		const walk = inner.walk?.bind(inner)
		if (walk !== undefined) {
			this.walk = async (dir, options) => {
				const entries = await walk(dir, options)
				this.census.record('walk', dir, 0)
				for (const entry of entries) this.census.record('walk', entry.path, 0)
				return entries
			}
		}

		const readFiles = inner.readFiles?.bind(inner)
		if (readFiles !== undefined) {
			this.readFiles = async (paths) => {
				const read = await readFiles(paths)
				for (const entry of read) this.census.record('readFiles', entry.path, entry.content?.byteLength ?? 0)
				return read
			}
		}

		const writeFiles = inner.writeFiles?.bind(inner)
		if (writeFiles !== undefined) {
			this.writeFiles = async (entries, options) => {
				const kept = entries.filter((entry) => !this.census.drops(entry.path))
				if (kept.length > 0) await writeFiles(kept, options)
				for (const entry of kept) this.census.record('writeFiles', entry.path, byteLength(entry.content))
			}
		}

		const rmFiles = inner.rmFiles?.bind(inner)
		if (rmFiles !== undefined) {
			this.rmFiles = async (paths, options) => {
				await rmFiles(paths, options)
				for (const path of paths) this.census.record('rmFiles', path, 0)
			}
		}

		this.scopeReads = inner.scopeReads?.bind(inner)
	}

	readFile(path: string): Promise<FsBytes>
	readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>
	async readFile(path: string, encoding?: 'utf-8' | 'utf8'): Promise<FsBytes | string> {
		if (encoding === undefined) {
			const data = await this.inner.readFile(path)
			this.census.record('readFile', path, data.byteLength)
			return data
		}
		const text = await this.inner.readFile(path, encoding)
		this.census.record('readFile', path, byteLength(text))
		return text
	}

	async writeFile(path: string, data: string | Uint8Array): Promise<void> {
		if (this.census.drops(path)) return
		await this.inner.writeFile(path, data)
		this.census.record('writeFile', path, byteLength(data))
	}

	async appendFile(path: string, data: string | Uint8Array): Promise<void> {
		if (this.census.drops(path)) return
		await this.inner.appendFile(path, data)
		this.census.record('appendFile', path, byteLength(data))
		this.census.inspect(path, data)
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		await this.inner.mkdir(path, options)
		this.census.record('mkdir', path, 0)
	}

	readdir(path: string): Promise<string[]>
	readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
	async readdir(path: string, options?: { withFileTypes: true }): Promise<string[] | Dirent[]> {
		this.census.record('readdir', path, 0)
		return options === undefined ? this.inner.readdir(path) : this.inner.readdir(path, options)
	}

	async stat(path: string): Promise<Stats> {
		this.census.record('stat', path, 0)
		return this.inner.stat(path)
	}

	async access(path: string, mode?: number): Promise<void> {
		this.census.record('access', path, 0)
		return this.inner.access(path, mode)
	}

	async unlink(path: string): Promise<void> {
		this.census.record('unlink', path, 0)
		return this.inner.unlink(path)
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		this.census.record('rm', path, 0)
		return this.inner.rm(path, options)
	}

	async cp(source: string, dest: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		this.census.record('cp', source, 0)
		return this.inner.cp(source, dest, options)
	}

	async open(path: string, flags?: string): Promise<ReadableFileHandle> {
		this.census.record('open', path, 0)
		return this.inner.open(path, flags)
	}

	async exists(path: string): Promise<boolean> {
		this.census.record('exists', path, 0)
		return this.inner.exists(path)
	}

	async realpath(path: string): Promise<string> {
		this.census.record('realpath', path, 0)
		return this.inner.realpath(path)
	}
}

interface Installed {
	census: FsCensus
	raw: FileSystem
	wrapper: CountingFileSystem
}

/** Survives between requests, because the SDK booted on it and cannot be re-handed one. */
let installed: Installed | undefined

/**
 * Put the census in front of `platform.fs`, once per Durable Object.
 *
 * This module outlives the actor: workerd may reconstruct the DO between two
 * requests to the same id, and the new one has its own workspace bound to its
 * own storage. A wrapper held over from the previous actor would then reach
 * across and fail with "Cannot perform I/O on behalf of a different Durable
 * Object" — so identity is checked against the platform, not against a flag.
 */
function installCensus(context: LimitProbeContext): Installed {
	const current = context.platform.fs
	const existing = installed
	if (existing !== undefined && current === existing.wrapper) return existing

	const census = new FsCensus()
	// Before boot(): bootstrap reads platform.fs once and hands it to every
	// consumer, so a swap after that would be counted by nobody.
	const wrapper = new CountingFileSystem(current, census)
	context.platform.fs = wrapper
	installed = { census, raw: current, wrapper }
	return installed
}

// ============================================================================
// Clock
// ============================================================================

/** workerd pins `Date.now()` between I/O, so every reading is taken after a yield. */
async function now(): Promise<number> {
	await scheduler.wait(0)
	return Date.now()
}

async function timedBlock(fn: () => Promise<void>): Promise<number> {
	const start = await now()
	await fn()
	return (await now()) - start
}

// ============================================================================
// Driving a turn
// ============================================================================

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
 * Wait until every agent has stopped.
 *
 * Idle is confirmed twice: `sendMessage` returns before the entry agent is
 * marked busy, so a single reading taken straight after it reports the turn
 * settled before it has begun — and the census would then miss the whole turn.
 */
async function settle(session: Session, timeoutMs: number): Promise<boolean> {
	const deadline = (await now()) + timeoutMs
	while ((await now()) < deadline) {
		if (agentsIdle(session)) {
			await scheduler.wait(20)
			if (agentsIdle(session)) return true
		}
		await scheduler.wait(20)
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

// ============================================================================
// Reporting
// ============================================================================

interface TrafficReport {
	rows: OpTally[]
	totals: { ops: number; bytes: number; writeOps: number; writeBytes: number }
	paths: Record<string, string[]>
}

function readTraffic(census: FsCensus): TrafficReport {
	// Copied, not referenced: the census keeps mutating its tallies, and a later
	// phase would otherwise rewrite the numbers this snapshot already reported.
	const rows = [...census.tallies.values()].map((tally) => ({ ...tally })).sort((a, b) => b.count - a.count)
	const totals = { ops: 0, bytes: 0, writeOps: 0, writeBytes: 0 }
	for (const row of rows) {
		totals.ops += row.count
		totals.bytes += row.bytes
		if (row.op === 'writeFile' || row.op === 'appendFile') {
			totals.writeOps += row.count
			totals.writeBytes += row.bytes
		}
	}
	const paths: Record<string, string[]> = {}
	for (const [pathClass, seen] of census.paths) paths[pathClass] = [...seen]
	return { rows, totals, paths }
}

function topLogLines(census: FsCensus, limit: number): { line: string; count: number }[] {
	return [...census.logLines.entries()]
		.map(([line, count]) => ({ line, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, limit)
}

function tallyOf(report: TrafficReport, pathClass: string, op: FsOp): OpTally {
	return report.rows.find((row) => row.pathClass === pathClass && row.op === op)
		?? { pathClass, op, count: 0, bytes: 0, maxBytes: 0 }
}

interface StoredLog {
	rows: number
	bytes: number
	distinctMessages: number
	topLines: { line: string; count: number }[]
}

/**
 * Where the session log went once it stopped being a file.
 *
 * The census cannot see it: a store-backed log never reaches `platform.fs`, which
 * is the whole point. Read straight off the DO's own SQL, so the two halves of the
 * before/after sit in one report — appends that vanished, rows that appeared — and
 * so the "what is being logged" tally survives the move.
 */
function storedLog(context: LimitProbeContext, sessionId: string): StoredLog | null {
	if (context.platform.sessionLog === undefined) return null

	const rows = context.ctx.storage.sql
		.exec<{ line: string }>('SELECT line FROM roj_session_log WHERE session_id = ? ORDER BY seq', sessionId)
		.toArray()

	const tally = new Map<string, number>()
	let bytes = 0
	for (const row of rows) {
		// +1 for the newline the file sink wrote, so the byte figures compare.
		bytes += byteLength(row.line) + 1
		const key = describeLogLine(row.line)
		tally.set(key, (tally.get(key) ?? 0) + 1)
	}

	const topLines = [...tally.entries()]
		.map(([line, count]) => ({ line, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 20)

	return { rows: rows.length, bytes, distinctMessages: tally.size, topLines }
}

// ============================================================================
// Cost calibration
// ============================================================================

interface CostRow {
	what: string
	ops: number
	bytesPerOp: number
	msPerOp: number
}

/**
 * What one append costs at the size the session log reaches.
 *
 * The adapter emulates `appendFile` as `lstat` + `writeRangeSync` at the current
 * end, so the seed size is the variable worth sweeping: it is the answer to
 * "does a log get more expensive as it grows".
 */
async function appendCost(fs: FileSystem, line: string, seedBytes: number, ops: number): Promise<CostRow> {
	const path = `${COST_DIR}/append-${seedBytes}.log`
	await fs.writeFile(path, seedBytes === 0 ? '' : 'x'.repeat(seedBytes - 1) + '\n')
	const ms = await timedBlock(async () => {
		for (let i = 0; i < ops; i++) await fs.appendFile(path, line)
	})
	await fs.rm(path, { force: true })
	return { what: `appendFile onto a ${seedBytes} B file`, ops, bytesPerOp: byteLength(line), msPerOp: ms / ops }
}

/** What reading a whole entry back costs — what `completeCall` does before rewriting it. */
async function readCost(fs: FileSystem, bytes: number, ops: number): Promise<CostRow> {
	const path = `${COST_DIR}/read-${bytes}.json`
	await fs.writeFile(path, 'x'.repeat(bytes))
	const ms = await timedBlock(async () => {
		for (let i = 0; i < ops; i++) await fs.readFile(path, 'utf-8')
	})
	await fs.rm(path, { force: true })
	return { what: `readFile of ${bytes} B, whole file`, ops, bytesPerOp: bytes, msPerOp: ms / ops }
}

async function writeCost(fs: FileSystem, bytes: number, ops: number): Promise<CostRow> {
	const path = `${COST_DIR}/write-${bytes}.json`
	const payload = 'x'.repeat(bytes)
	const ms = await timedBlock(async () => {
		for (let i = 0; i < ops; i++) await fs.writeFile(path, payload)
	})
	await fs.rm(path, { force: true })
	return { what: `writeFile of ${bytes} B, whole file`, ops, bytesPerOp: bytes, msPerOp: ms / ops }
}

/**
 * What a log row would cost: one bound INSERT into the DO's own SQLite.
 *
 * The table mirrors `SqliteEventStore`'s — clustered on `(session_id, seq)`, no
 * rowid — so the figure is what a real per-session log table would pay, not what
 * an unkeyed heap insert would.
 */
async function sqlInsertCost(context: LimitProbeContext, line: string, ops: number): Promise<CostRow> {
	const sql = context.ctx.storage.sql
	sql.exec(
		`CREATE TABLE IF NOT EXISTS probe_fs_traffic (
			session_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			line TEXT NOT NULL,
			PRIMARY KEY (session_id, seq)
		) WITHOUT ROWID`,
	)
	sql.exec('DELETE FROM probe_fs_traffic')
	const ms = await timedBlock(async () => {
		for (let i = 0; i < ops; i++) {
			sql.exec('INSERT INTO probe_fs_traffic (session_id, seq, line) VALUES (?, ?, ?)', 'probe', i, line)
		}
	})
	sql.exec('DROP TABLE probe_fs_traffic')
	return { what: `INSERT one row of ${byteLength(line)} B into DO SQLite`, ops, bytesPerOp: byteLength(line), msPerOp: ms / ops }
}

/**
 * What completing a call costs as a row: a keyed `UPDATE` of the small columns.
 *
 * The blob is in the row being updated, because SQLite rewrites the whole record
 * either way — the split saves the read, the parse and the re-serialize, and this
 * figure says whether it also saves the write. Keyed on a unique index over
 * `(session_id, seq)`, as `SqliteLLMCallLog` is.
 */
async function sqlUpdateCost(context: LimitProbeContext, blob: string, ops: number): Promise<CostRow> {
	const sql = context.ctx.storage.sql
	sql.exec(
		`CREATE TABLE IF NOT EXISTS probe_fs_update (
			session_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			request TEXT NOT NULL,
			response TEXT
		)`,
	)
	sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS probe_fs_update_key ON probe_fs_update (session_id, seq)')
	sql.exec('DELETE FROM probe_fs_update')
	sql.exec('INSERT INTO probe_fs_update (session_id, seq, request) VALUES (?, ?, ?)', 'probe', 0, blob)
	const response = JSON.stringify({ content: 'x'.repeat(400), finishReason: 'stop' })
	const ms = await timedBlock(async () => {
		for (let i = 0; i < ops; i++) {
			sql.exec('UPDATE probe_fs_update SET response = ? WHERE session_id = ? AND seq = ?', response, 'probe', 0)
		}
	})
	sql.exec('DROP TABLE probe_fs_update')
	return {
		what: `UPDATE the response columns beside a ${byteLength(blob)} B request`,
		ops,
		bytesPerOp: byteLength(response),
		msPerOp: ms / ops,
	}
}

// ============================================================================
// LLM call log
// ============================================================================

interface InferenceSize {
	agentId: string
	systemPromptBytes: number
	messagesBytes: number
	toolSchemaBytes: number
	toolsOffered: number
}

/**
 * Sizes the request the SDK hands a provider.
 *
 * `LLMLogger` stores exactly this — system prompt, messages, every tool's JSON
 * schema. The sizes say what a call is made of; the arms below say what storing
 * it costs.
 */
class SizingProvider implements LLMProvider {
	readonly name: string
	readonly sizes: InferenceSize[] = []

	constructor(private readonly inner: LLMProvider) {
		this.name = inner.name
	}

	async inference(request: InferenceRequest, context?: InferenceContext): Promise<Result<InferenceResponse, LLMError>> {
		this.sizes.push({
			agentId: context?.agentId ?? 'unknown',
			systemPromptBytes: byteLength(request.systemPrompt),
			messagesBytes: byteLength(JSON.stringify(request.messages)),
			toolSchemaBytes: byteLength(JSON.stringify((request.tools ?? []).map((tool) => tool.input.toJSONSchema()))),
			toolsOffered: request.tools?.length ?? 0,
		})
		return this.inner.inference(request, context)
	}
}

// ============================================================================
// Probe
// ============================================================================

export const fsTrafficProbe: LimitProbe = async (context) => {
	const { census, raw } = installCensus(context)
	const abRounds = Number(context.params.get('ab') ?? 0)
	const costOps = Number(context.params.get('costOps') ?? COST_OPS)

	// --- phase: turn -------------------------------------------------------
	census.reset()
	const booted = context.boot()
	const session = await startSession(booted)
	const sessionId = String(session.id)
	const createTraffic = readTraffic(census)

	census.reset()
	await sendMessage(session, context.params.get('message') ?? 'Please write a note file.')
	const settled = await settle(session, SETTLE_TIMEOUT_MS)
	const turnTraffic = readTraffic(census)
	// Snapshotted here, not at return: the phases below keep writing log lines.
	const logLines = { distinct: census.logLines.size, top: topLogLines(census, 20) }
	const stored = storedLog(context, sessionId)
	const events = (await booted.services.eventStore.load(SessionId(sessionId))).length

	// --- phase: cost -------------------------------------------------------
	const logAppend = tallyOf(turnTraffic, 'session.log', 'appendFile')
	// The same lines either way; only the sink moved. Taking the count from whichever
	// sink this host used keeps the projection pricing the log after the move.
	const logCount = logAppend.count > 0 ? logAppend.count : stored?.rows ?? 0
	const logBytes = logAppend.count > 0 ? logAppend.bytes : stored?.bytes ?? 0
	const meanLineBytes = logCount > 0 ? Math.round(logBytes / logCount) : FALLBACK_LINE_BYTES
	const line = 'x'.repeat(Math.max(meanLineBytes - 1, 1)) + '\n'

	await raw.mkdir(COST_DIR, { recursive: true })
	const cost: CostRow[] = [
		await appendCost(raw, line, 0, costOps),
		await appendCost(raw, line, 64 * 1024, costOps),
		await appendCost(raw, line, 1024 * 1024, costOps),
		await writeCost(raw, 4 * 1024, costOps),
		await writeCost(raw, 64 * 1024, costOps),
		await sqlInsertCost(context, line, costOps),
	]

	const appendMs = cost[0]?.msPerOp ?? 0
	const insertMs = cost[cost.length - 1]?.msPerOp ?? 0

	// The call log's own sizes, taken after the session-log projection has its figures:
	// one ~17 KB entry written whole and read back, against one row created and updated.
	const callBlob = 'x'.repeat(17 * 1024)
	cost.push(
		await writeCost(raw, callBlob.length, costOps),
		await readCost(raw, callBlob.length, costOps),
		await sqlInsertCost(context, callBlob, costOps),
		await sqlUpdateCost(context, callBlob, costOps),
	)
	await raw.rm(COST_DIR, { recursive: true, force: true })

	// --- phase: A/B --------------------------------------------------------
	const ab = abRounds > 0 ? await runAb(booted, census, abRounds) : null

	// --- phase: llm --------------------------------------------------------
	const llm = await measureLlmCallLog(context, booted.services, census, raw)

	return {
		what: 'every platform.fs call the isolate profile makes during one real session, with what one call costs',
		sessionId,
		settled,
		events,
		createSession: { traffic: createTraffic },
		turn: {
			traffic: turnTraffic,
			sessionLog: {
				lines: logCount,
				bytes: logBytes,
				appends: logAppend.count,
				meanLineBytes,
				distinctMessages: stored?.distinctMessages ?? logLines.distinct,
				topLines: stored?.topLines ?? logLines.top,
				// Null where the host has no store, and the appends above are the whole log.
				store: stored,
			},
		},
		cost,
		projection: {
			sessionLogMsPerTurn: logCount * appendMs,
			sessionLogMsPerTurnAsRows: logCount * insertMs,
			savedMsPerTurn: logCount * (appendMs - insertMs),
			reads: 'count x calibrated ms/op. The turn itself costs ~10 ms of CPU (see /limits/turn-cost).',
		},
		ab,
		llm,
		caveats: [
			'wrangler dev enforces no CPU budget; these are local millisecond costs, a magnitude not a quota.',
			'The llm phase builds its own SessionManager, so it runs on a LiveScheduler — git-status polls there and this host does not.',
			'appendFile here is the adapter emulation (lstat + writeRangeSync at the end); upstream rejects it with ENOSYS.',
		],
	}
}

/**
 * The same turn with and without the `session.log` writes.
 *
 * Each round gets a fresh session, because the scripted provider plays the
 * two-agent script once per session and answers every later message with a bare
 * stop — a second turn on the same session is not the same turn.
 *
 * A cross-check on the projection, not a substitute for it: a debounce hop puts
 * hundreds of milliseconds of wall around whatever the writes cost, so only the
 * sign and the order of magnitude survive.
 */
async function runAb(booted: Booted, census: FsCensus, rounds: number): Promise<unknown> {
	const inspectLogLines = census.inspectLogLines
	census.inspectLogLines = false

	const arm = async (suppressed: string | null): Promise<number> => {
		const session = await startSession(booted)
		census.suppressed = suppressed
		const ms = await timedBlock(async () => {
			await sendMessage(session, 'Please write a note file.')
			await settle(session, SETTLE_TIMEOUT_MS)
		})
		census.suppressed = null
		await session.close()
		return ms
	}

	let withLog = 0
	let withoutLog = 0
	// Interleaved, so a box that gets busier mid-run loads both arms equally.
	for (let round = 0; round < rounds; round++) {
		withLog += await arm(null)
		withoutLog += await arm('session.log')
	}
	census.inspectLogLines = inspectLogLines

	return {
		rounds,
		withLogMs: withLog / rounds,
		withoutLogMs: withoutLog / rounds,
		deltaMs: (withLog - withoutLog) / rounds,
	}
}

interface LlmArm {
	sink: 'files' | 'rows'
	sessionId: string
	settled: boolean
	inferences: number
	sizes: InferenceSize[]
	/** Compact bytes of the requests the SDK built — what the sink was asked to hold. */
	requestBytesTotal: number
	/** Wall time of the turn. Debounce dominates it, so read the traffic, not this. */
	ms: number
	traffic: TrafficReport
	/** Rows and bytes the store ended up holding. Null on the files arm. */
	stored: { rows: number; bytes: number } | null
	/** What `listCalls` gives back, read through the same sink that just wrote it. */
	page: { total: number; calls: { id: string; status: string; model: string; tools: number; totalTokens: number }[] }
}

/**
 * One turn with the call log written, on a manager of this phase's own.
 *
 * The logger is constructed here rather than taken from `services`, because
 * `bootstrap` never builds one under `config.llmMock` — the guard is in the
 * composition root, not in `LLMLogger`, so the mock provider still produces real
 * `InferenceRequest`s to log. `services.platform.fs` is the counted wrapper, so
 * the files arm lands in the census as the `llm call log` path class.
 */
async function runLlmArm(context: LimitProbeContext, services: Services<'isolate'>, census: FsCensus, useStore: boolean): Promise<LlmArm> {
	const store = useStore ? context.platform.llmCallLog : undefined
	const logger = new LLMLogger({ basePath: services.config.dataPath, enabled: true, fs: services.platform.fs, store })
	const provider = new SizingProvider(services.llmProvider)
	const withLogging = new LoggingLLMProvider(provider, logger)
	const system = createSystemFromServices(withOwnScheduler({ ...services, llmProvider: withLogging, llmLogger: logger }))
	const created = await system.sessionManager.createSession(isolatePreset.id)
	if (!created.ok) throw new Error(`llm phase createSession failed: ${JSON.stringify(created.error)}`)

	const sessionId = String(created.value.id)
	census.reset()
	let settled = false
	const ms = await timedBlock(async () => {
		await sendMessage(created.value, 'Please write a note file.')
		settled = await settle(created.value, SETTLE_TIMEOUT_MS)
	})
	const traffic = readTraffic(census)
	// Read back through the same sink, uncounted, so the paging contract is checked on
	// the host rather than only in a unit test: newest first, `total` before the page.
	const listed = await logger.listCalls(SessionId(sessionId), { limit: 3, offset: 0 })
	await created.value.close()
	await system.shutdown()

	return {
		sink: useStore ? 'rows' : 'files',
		sessionId,
		settled,
		inferences: provider.sizes.length,
		sizes: provider.sizes,
		requestBytesTotal: provider.sizes.reduce((sum, size) => sum + size.systemPromptBytes + size.messagesBytes + size.toolSchemaBytes, 0),
		ms,
		traffic,
		stored: useStore ? storedCalls(context, sessionId) : null,
		page: {
			total: listed.total,
			calls: listed.calls.map((call) => ({
				id: call.id,
				status: call.status,
				model: call.request.model,
				tools: call.request.tools?.length ?? 0,
				totalTokens: call.metrics?.totalTokens ?? 0,
			})),
		},
	}
}

/** What the call-log table ended up holding, read straight off the DO's own SQL. */
function storedCalls(context: LimitProbeContext, sessionId: string): { rows: number; bytes: number } {
	const rows = context.ctx.storage.sql
		.exec<{ request: string; response: string | null; metrics: string | null }>(
			'SELECT request, response, metrics FROM roj_llm_call WHERE session_id = ?',
			sessionId,
		)
		.toArray()

	let bytes = 0
	for (const row of rows) {
		bytes += byteLength(row.request) + byteLength(row.response ?? '') + byteLength(row.metrics ?? '')
	}
	return { rows: rows.length, bytes }
}

/**
 * Both sinks for the same turn, and the difference between them.
 *
 * The files arm is a fresh session each time, so its `calls/` directory is its
 * own; it is removed through the raw filesystem afterwards, uncounted, so the
 * probe does not leave 70 KB behind per run.
 */
async function measureLlmCallLog(
	context: LimitProbeContext,
	services: Services<'isolate'>,
	census: FsCensus,
	raw: FileSystem,
): Promise<Record<string, unknown>> {
	const files = await runLlmArm(context, services, census, false)
	const rows = context.platform.llmCallLog === undefined ? null : await runLlmArm(context, services, census, true)

	await raw.rm(`${services.config.dataPath}/sessions/${files.sessionId}`, { recursive: true, force: true })

	return {
		what: 'the LLM call log written twice — as files, then as rows — on one box',
		note: 'bootstrap skips LLMLogger under config.llmMock; this phase constructs it, so the guard is not in the way',
		files,
		rows,
		saved: rows === null ? null : {
			fsOps: files.traffic.totals.ops - rows.traffic.totals.ops,
			writeOps: files.traffic.totals.writeOps - rows.traffic.totals.writeOps,
			writeBytes: files.traffic.totals.writeBytes - rows.traffic.totals.writeBytes,
		},
		reads: 'sizes are compact JSON; the files sink stringifies with two-space indent, so the files are larger than the sizes say.',
	}
}
