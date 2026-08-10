/**
 * Durable Object harness: the roj SDK running inside a Worker isolate,
 * against a @cloudflare/computer workspace filesystem.
 *
 * `GET /run` boots the SDK through its normal composition root, runs a
 * two-agent session on a scripted LLM, and reports what landed in the workspace.
 * `GET /bench` measures how session replay scales with event-log length.
 * `GET /shell` probes what the just-bash shell backend actually implements.
 */

import { Workspace, WorkspaceServiceProxy } from '@cloudflare/computer'
import type { DurableObjectStorageLike, WorkspaceStub } from '@cloudflare/computer'
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell'
import { createGitClient } from '@cloudflare/computer/git'
import { SqliteEventStore, createAlarmScheduler, createComputerPlatform, createSessionReaper, createShellProcessRunner } from '@roj-ai/computer-platform'
import type { AlarmScheduler, ReapOptions, SessionReaper } from '@roj-ai/computer-platform'
import { FileEventStore, JsonLogger, bootstrap, createSystemFromServices, isolatePlugins } from '@roj-ai/sdk'
import type { Config, IsolateMethodSchemas, Services, Session, SessionId, System } from '@roj-ai/sdk'
import type { Platform } from '@roj-ai/sdk/platform'
import { DurableObject } from 'cloudflare:workers'
import { runBench } from './bench.js'
import type { BenchResult } from './bench.js'
import { createDoTransport } from './do-transport.js'
import type { DoTransport } from './do-transport.js'
import type { WakeLogEntry } from './limits/context.js'
import { LIMIT_PROBES, LIMIT_PROBE_NAMES } from './limits/index.js'
import { NOTE_PATH, scriptedHandler } from './mock-llm.js'
import { isolatePreset } from './preset.js'
import { runShellProbes } from './shell-probe.js'

/** The SDK's System narrowed to the plugin set the isolate profile registers. */
type IsolateSystem = System<IsolateMethodSchemas, typeof isolatePlugins>

/** workerd freezes its clock between I/O, so a timer yield is what advances it (see bench.ts). */
async function timedBlock(fn: () => Promise<void>): Promise<number> {
	await scheduler.wait(0)
	const start = Date.now()
	await fn()
	await scheduler.wait(0)
	return Date.now() - start
}

/** EventStore errors wrap the real failure in `cause`, which stringifies to nothing. */
function describeError(error: unknown): { error: string; cause?: string; stack?: string } {
	if (!(error instanceof Error)) return { error: String(error) }
	const cause = 'cause' in error ? error.cause : undefined
	return {
		error: error.message,
		cause: cause === undefined ? undefined : cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
		stack: error.stack,
	}
}

interface Env {
	AGENT: DurableObjectNamespace<RojAgentDO>
	LOADER: WorkerLoader
}

/** Roj writes sessions, events and agent files below this root in the workspace. */
const DATA_ROOT = '/data'

/** Selector the shell backend is registered under; `execFile` names it explicitly. */
const SHELL_BACKEND = 'shell'

/** Alarm drains kept for /limits/scheduler to read back. Bounded — this is a debug tail. */
const WAKE_LOG_LIMIT = 50

/** Pulls per phase in the git-status gate measurement. */
const GATE_ROUNDS = 25

/** A gated pull is far too cheap to time once, so its phase runs this many times more. */
const GATED_MULTIPLIER = 20

/** Repository /git builds in a session workspace — a commit, then a dirty file. */
const GIT_SETUP = [
	'git init',
	'echo "first" > note.txt',
	'git add note.txt',
	'git commit -m "add note"',
	'echo "second" >> note.txt',
	'echo "untracked" > scratch.txt',
] as const

/** `loadConfig()` reads process.env/cwd, which a Worker isolate has neither of. */
const config: Config = {
	port: 0,
	host: 'localhost',
	dataPath: DATA_ROOT,
	// Inert — #boot swaps in SqliteEventStore, and Config has no mode that names it.
	persistence: 'file',
	logLevel: 'info',
	logFormat: 'json',
	llmMock: scriptedHandler,
}

export class RojAgentDO extends DurableObject<Env> {
	readonly #workspace: Workspace
	readonly #platform: Platform
	readonly #eventStore: SqliteEventStore
	readonly #reaper: SessionReaper
	readonly #transport: DoTransport
	readonly #scheduler: AlarmScheduler
	/** Everything plugins have notified since boot — how /git observes git-status. */
	readonly #notifications: { type: string; payload: unknown }[] = []
	/**
	 * What the transport did with those notifications, since it cannot be read back
	 * off a socket: `dropped` is data the WebSocket layer threw away, and used to be
	 * invisible from anywhere. `/run` reports it.
	 */
	readonly #delivery = { broadcasts: 0, peers: 0, delivered: 0, buffered: 0, dropped: 0 }
	/** Tail of alarm drains, so a probe can show which wakes the alarm delivered. */
	readonly #wakeLog: WakeLogEntry[] = []
	#booted?: { services: Services<'isolate'>; system: IsolateSystem }

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		// computer types exec<Row extends object>, workers-types exec<T extends
		// Record<string, SqlStorageValue>> — the param is phantom at runtime.
		const storage = ctx.storage as unknown as DurableObjectStorageLike
		this.#workspace = new Workspace({
			storage,
			backends: [
				new WorkerShellBackend({
					id: SHELL_BACKEND,
					loader: env.LOADER,
					// How the shell's Dynamic Worker dials back to __getWorkspaceStub below.
					workspace: { binding: 'AGENT', id: ctx.id.toString() },
					ctx,
				}),
			],
			// Backs both the shell's `git` command and platform.git; without it the
			// workspace has no git client and every invocation rejects.
			git: createGitClient(),
			// The isolate has no user, and a commit needs an author to attribute.
			defaultGitIdentity: { name: 'roj', email: 'roj@example.invalid' },
		})
		// The agent loop re-enters through this instead of a timer, so a wake armed by
		// one isolate is delivered by whichever one alarm() lands in — see alarm().
		this.#scheduler = createAlarmScheduler(ctx)
		this.#platform = {
			...createComputerPlatform(this.#workspace, { scheduler: this.#scheduler }),
			// createComputerPlatform defaults to ENOSYS; this workspace has a shell to run on.
			process: createShellProcessRunner(this.#workspace, { backend: SHELL_BACKEND }),
		}
		this.#eventStore = new SqliteEventStore(storage)
		// Reclaiming is the host's call, not a session hook's — see session-reaper.ts.
		// Nothing calls this on its own; /reap and /limits/reaper are the two triggers.
		this.#reaper = createSessionReaper({ eventStore: this.#eventStore, fs: this.#platform.fs, dataDir: DATA_ROOT })
		// The transport is built before the boot that produces `services.logger`, and
		// sockets already open, close and lose frames by then — so it gets its own.
		this.#transport = createDoTransport(ctx, () => this.#boot(), new JsonLogger(config.logLevel))
	}

	fetch(request: Request): Promise<Response> {
		return this.#transport.fetch(request)
	}

	/**
	 * Deliver the agent-loop wakes that have come due.
	 *
	 * The reason the loop is on a scheduler at all: an alarm is a *delivered*
	 * event, so workerd tops the actor's CPU budget up for it, while a timer
	 * callback draws down a budget nothing refills. `dispatchWake` needs only the
	 * key — the session behind it is loaded from its event log if this isolate has
	 * never seen it.
	 */
	async alarm(): Promise<void> {
		const { system } = this.#boot()
		const errors: string[] = []
		const keys = await this.#scheduler.deliverDue(async (key) => {
			try {
				await system.sessionManager.dispatchWake(key)
			} catch (error) {
				errors.push(`${key}: ${describeError(error).error}`)
			}
		})

		this.#wakeLog.push({ at: Date.now(), keys, errors: errors.length > 0 ? errors : undefined })
		if (this.#wakeLog.length > WAKE_LOG_LIMIT) this.#wakeLog.shift()

		// The dispatch above armed the next hop and nothing else will wait for it.
		await this.#scheduler.flush()
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		this.#transport.webSocketMessage(ws, message)
	}

	webSocketClose(ws: WebSocket, code: number, reason: string): void {
		this.#transport.webSocketClose(ws, code, reason)
	}

	webSocketError(ws: WebSocket, error: unknown): void {
		this.#transport.webSocketError(ws, error)
	}

	/** Entry point for the shell backend's Dynamic Worker, via WorkspaceServiceProxy. */
	async __getWorkspaceStub(): Promise<WorkspaceStub> {
		await this.#workspace.ready()
		return this.#workspace.stub()
	}

	#boot(): { services: Services<'isolate'>; system: IsolateSystem } {
		const existing = this.#booted
		if (existing) return existing
		// bootstrap picks its store off config.persistence, which only knows file and
		// memory — swap in the store over the DO's own SQLite.
		const services: Services<'isolate'> = {
			...bootstrap(config, { presets: [isolatePreset] }, this.#platform, { pluginProfile: 'isolate' }),
			eventStore: this.#eventStore,
		}
		const system = createSystemFromServices(services, {
			onUserOutput: (notification) => {
				// Collected for /git to assert on, and fanned out to subscribed sockets.
				this.#notifications.push({ type: notification.type, payload: notification.payload })
				const delivery = this.#transport.broadcast(notification)
				this.#delivery.broadcasts += 1
				this.#delivery.peers += delivery.peers
				this.#delivery.delivered += delivery.delivered
				this.#delivery.buffered += delivery.buffered
				this.#delivery.dropped += delivery.dropped
			},
		})
		const booted = { services, system }
		this.#booted = booted
		return booted
	}

	/**
	 * Drop the booted SDK the way an eviction would — stop the old agents, forget
	 * every loaded session — while keeping the pending wakes.
	 *
	 * `SessionManager.shutdown()` cancels each agent's wakes, which is right when a
	 * session is being torn down and wrong when only the isolate is going away. The
	 * SDK cannot tell the two apart; the host can, so the shutdown runs suspended.
	 * `keepWakes: false` is the control — it shows what the unsuspended teardown costs.
	 */
	async #evictSdk(keepWakes: boolean): Promise<boolean> {
		const booted = this.#booted
		if (!booted) return false
		this.#booted = undefined
		const shutdown = () => booted.system.sessionManager.shutdown()
		await (keepWakes ? this.#scheduler.suspend(shutdown) : shutdown())
		return true
	}

	async run(message: string): Promise<Response> {
		const startedAt = Date.now()
		const stages: Record<string, number> = {}
		const mark = (stage: string) => {
			stages[stage] = Date.now() - startedAt
		}

		const { services, system } = this.#boot()
		mark('bootstrap')

		const created = await system.sessionManager.createSession(isolatePreset.id)
		if (!created.ok) {
			return Response.json({ ok: false, stage: 'createSession', error: created.error }, { status: 500 })
		}
		const session = created.value
		mark('createSession')

		const entryAgentId = session.getEntryAgentId()
		if (!entryAgentId) {
			return Response.json({ ok: false, stage: 'entryAgent', error: 'no entry agent' }, { status: 500 })
		}

		const sent = await session.callPluginMethod('user-chat.sendMessage', {
			sessionId: String(session.id),
			content: message,
			agentId: String(entryAgentId),
		})
		if (!sent.ok) {
			return Response.json({ ok: false, stage: 'sendMessage', error: sent.error }, { status: 500 })
		}

		const settled = await this.#waitForIdle(session)
		mark('agentsIdle')

		const events = await services.eventStore.load(session.id)
		mark('loadEvents')

		return Response.json({
			ok: true,
			settled,
			sessionId: String(session.id),
			stages,
			agents: [...session.state.agents.values()].map((agent) => ({ name: agent.definitionName, status: agent.status })),
			eventCount: events.length,
			notifications: { ...this.#delivery },
			data: await this.#tree(DATA_ROOT),
			workspace: await this.#tree('/workspace'),
			note: await this.#readNote(session.id),
		})
	}

	async bench(counts: number[], stores: readonly string[]): Promise<Response> {
		const { services } = this.#boot()
		try {
			const results: BenchResult[] = []
			for (const store of stores) {
				results.push(await runBench({
					services: store === 'file'
						? { ...services, eventStore: new FileEventStore(config.dataPath, this.#platform.fs) }
						: services,
					store,
					storedBytes: (sessionId) => this.#storedBytes(store, sessionId),
					presetId: isolatePreset.id,
					counts,
				}))
			}
			return Response.json({ ok: true, results })
		} catch (error) {
			return Response.json({ ok: false, ...describeError(error) }, { status: 500 })
		}
	}

	/**
	 * Reclaim what closed sessions left behind.
	 *
	 * The trigger lives on the host, not on `session.close()`: a closed session can
	 * still be reopened, its log is the only record it ever ran, and the SDK's close
	 * hooks fire for an isolate going away too. So the host says when — from an
	 * operator call like this one, or from a maintenance alarm on a deploy.
	 * `?events=1` opts into dropping the log as well; without it only files go.
	 */
	async reap(query: string): Promise<Response> {
		const params = new URLSearchParams(query)
		const optionalInt = (name: string): number | undefined => {
			const raw = params.get(name)
			if (raw === null) return undefined
			const value = Number(raw)
			if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number >= 0`)
			return Math.floor(value)
		}

		try {
			const options: ReapOptions = {
				events: params.get('events') === '1',
				dryRun: params.get('dryRun') === '1',
				minAgeMs: optionalInt('minAgeMs'),
				limit: optionalInt('limit'),
			}
			return Response.json({ ok: true, report: await this.#reaper.reap(options) })
		} catch (error) {
			return Response.json({ ok: false, ...describeError(error) }, { status: 500 })
		}
	}

	/** Runs one probe from src/limits/ — see LIMIT_PROBES for the roster. */
	async limits(name: string, query: string): Promise<Response> {
		const load = LIMIT_PROBES[name]
		if (!load) {
			return Response.json({ ok: false, error: `unknown probe '${name}'`, probes: LIMIT_PROBE_NAMES }, { status: 404 })
		}
		try {
			const probe = await load()
			const result = await probe({
				platform: this.#platform,
				workspace: this.#workspace,
				ctx: this.ctx,
				boot: () => this.#boot(),
				scheduler: this.#scheduler,
				reaper: this.#reaper,
				evictSdk: (keepWakes) => this.#evictSdk(keepWakes),
				wakeLog: () => this.#wakeLog,
				backend: SHELL_BACKEND,
				params: new URLSearchParams(query),
			})
			return Response.json({ ok: true, probe: name, result })
		} catch (error) {
			return Response.json({ ok: false, probe: name, ...describeError(error) }, { status: 500 })
		}
	}

	async shell(command: string | null): Promise<Response> {
		try {
			return Response.json({ ok: true, ...await runShellProbes({ platform: this.#platform, workspace: this.#workspace, backend: SHELL_BACKEND, command }) })
		} catch (error) {
			return Response.json({ ok: false, ...describeError(error) }, { status: 500 })
		}
	}

	/**
	 * End-to-end check of the git port: build a repo in a live session's workspace
	 * through the shell's `git`, then read it back both directly off `platform.git`
	 * and through the `git-status` plugin, and measure what the revision gate saves.
	 */
	async git(rounds: number): Promise<Response> {
		const { system } = this.#boot()
		const created = await system.sessionManager.createSession(isolatePreset.id)
		if (!created.ok) {
			return Response.json({ ok: false, stage: 'createSession', error: created.error }, { status: 500 })
		}
		const session = created.value
		const workdir = `/workspace/${session.id}`

		try {
			const shell: { command: string; exitCode: number; stdout: string; stderr: string }[] = []
			for (const command of GIT_SETUP) {
				const handle = await this.#workspace.runtime.exec(command, { backend: SHELL_BACKEND, encoding: 'utf8', cwd: workdir })
				try {
					const result = await handle.result()
					shell.push({ command, exitCode: result.exitCode ?? -1, stdout: result.stdout.trim(), stderr: result.stderr.trim() })
				} finally {
					handle[Symbol.dispose]()
				}
			}

			const git = this.#platform.git
			const port = git === undefined ? null : {
				status: await git.status({ dir: workdir }),
				log: await git.log({ dir: workdir, depth: 1 }),
				countAhead: await git.countAhead({ dir: workdir, base: 'main' }),
				defaultBranch: await git.defaultBranch({ dir: workdir }) ?? null,
			}

			// Nothing wrote through a tool call here, and an alarm-driven host runs no
			// poll — so the harness pulls, exactly as a client would.
			const pulled = await session.callPluginMethod('git-status.refresh', { sessionId: String(session.id) })
			const notified = this.#notifications.filter((entry) => entry.type === 'git_status_changed').at(-1)?.payload ?? null

			return Response.json({
				ok: true,
				sessionId: String(session.id),
				workdir,
				shell,
				port,
				refresh: pulled.ok ? pulled.value : { error: pulled.error },
				notified,
				gate: rounds > 0 ? await this.#measureGate(session, workdir, rounds) : null,
			})
		} catch (error) {
			return Response.json({ ok: false, ...describeError(error) }, { status: 500 })
		}
	}

	/**
	 * What `git-status`'s revision gate is worth: a pull that replays the answer it
	 * has against one that recomputes it.
	 *
	 * Phases are bracketed once and divided rather than timed per pull — workerd
	 * freezes the clock between I/O, so every reading costs a scheduler yield (see
	 * bench.ts). The write that forces a recomputation is timed on its own and
	 * subtracted, so `ungatedMs` is the pull alone in both rows.
	 */
	async #measureGate(session: Session, workdir: string, rounds: number): Promise<Record<string, number | null>> {
		const revision = async (): Promise<number | null> => await this.#platform.fsRevision?.current() ?? null
		const pull = async () => {
			await session.callPluginMethod('git-status.refresh', { sessionId: String(session.id) })
		}
		const write = (round: number) => this.#platform.fs.writeFile(`${workdir}/scratch.txt`, `round ${round}\n`)

		// The first pull after the shell setup also detects the default branch.
		await pull()

		const gatedRounds = rounds * GATED_MULTIPLIER
		const before = await revision()
		const gatedMs = await timedBlock(async () => {
			for (let i = 0; i < gatedRounds; i++) await pull()
		})
		// Equal to `before` iff nothing wrote — the precondition the gate needs, and
		// the check that the git read itself is not quietly touching the workspace.
		const after = await revision()

		const writeMs = await timedBlock(async () => {
			for (let i = 0; i < rounds; i++) await write(i)
		})
		const bothMs = await timedBlock(async () => {
			for (let i = 0; i < rounds; i++) {
				await write(rounds + i)
				await pull()
			}
		})

		return {
			rounds,
			gatedRounds,
			gatedMs: gatedMs / gatedRounds,
			ungatedMs: (bothMs - writeMs) / rounds,
			writeMs: writeMs / rounds,
			revisionBefore: before,
			revisionAfter: after,
		}
	}

	/** Bytes the store under test holds for one session — a JSONL file, or event rows. */
	async #storedBytes(store: string, sessionId: SessionId): Promise<number> {
		if (store === 'file') {
			const stats = await this.#platform.fs.stat(`${config.dataPath}/sessions/${sessionId}/.events/events.jsonl`)
			return stats.size
		}
		const rows = this.ctx.storage.sql
			.exec<{ bytes: number | null }>('SELECT SUM(LENGTH(payload)) AS bytes FROM roj_events WHERE session_id = ?', sessionId)
			.toArray()
		return rows[0]?.bytes ?? 0
	}

	/** Mirrors testing/wait-helpers, which can't be imported here — it pulls in node:fs. */
	async #waitForIdle(session: Session, timeoutMs = 20_000): Promise<boolean> {
		const isIdle = () => {
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

		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			if (isIdle()) {
				await scheduler.wait(20)
				if (isIdle()) return true
			}
			await scheduler.wait(20)
		}
		return false
	}

	/** Read back what the writer agent produced, through the adapter. */
	async #readNote(sessionId: string): Promise<string | null> {
		try {
			// Agents see the sandboxed virtual path; on disk it lives under workspaceDir.
			return await this.#platform.fs.readFile(`/workspace/${sessionId}/${NOTE_PATH.split('/').pop()}`, 'utf-8')
		} catch {
			return null
		}
	}

	/** Recursive listing straight off the platform adapter — proves the FS round-trips. */
	async #tree(path: string, depth = 0): Promise<string[]> {
		if (depth > 5) return []
		const out: string[] = []
		let names: string[]
		try {
			names = await this.#platform.fs.readdir(path)
		} catch {
			return out
		}
		for (const name of names.sort()) {
			const child = `${path}/${name}`
			const stats = await this.#platform.fs.stat(child)
			if (stats.isDirectory()) {
				out.push(`${child}/`)
				out.push(...await this.#tree(child, depth + 1))
			} else {
				out.push(`${child} (${stats.size}b)`)
			}
		}
		return out
	}
}

/** The shell backend mints its Dynamic Worker with a loopback binding to this. */
export { WorkspaceServiceProxy }

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const stub = env.AGENT.get(env.AGENT.idFromName('smoke'))
		if (url.pathname === '/run') {
			return stub.run(url.searchParams.get('message') ?? 'Please write a note file.')
		}
		if (url.pathname === '/bench') {
			const counts = (url.searchParams.get('counts') ?? '100,500,1000,5000,10000').split(',').map(Number)
			if (counts.some((count) => !Number.isSafeInteger(count) || count <= 0)) {
				return new Response('counts must be positive integers\n', { status: 400 })
			}
			const stores = (url.searchParams.get('stores') ?? 'sqlite').split(',')
			if (stores.some((store) => store !== 'sqlite' && store !== 'file')) {
				return new Response('stores must be sqlite and/or file\n', { status: 400 })
			}
			return stub.bench(counts, stores)
		}
		if (url.pathname === '/shell') {
			return stub.shell(url.searchParams.get('cmd'))
		}
		if (url.pathname === '/git') {
			const rounds = Number(url.searchParams.get('rounds') ?? GATE_ROUNDS)
			if (!Number.isSafeInteger(rounds) || rounds < 0) {
				return new Response('rounds must be a non-negative integer\n', { status: 400 })
			}
			// Each run leaves a repo behind, so give every one its own DO.
			return env.AGENT.get(env.AGENT.idFromName(`git:${crypto.randomUUID()}`)).git(rounds)
		}
		if (url.pathname === '/reap') {
			return stub.reap(url.search)
		}
		if (url.pathname === '/limits') {
			return Response.json({ probes: LIMIT_PROBE_NAMES })
		}
		if (url.pathname.startsWith('/limits/')) {
			// Each probe gets its own DO, so one that OOMs or fills storage cannot
			// poison the measurements of the next.
			const name = url.pathname.slice('/limits/'.length)
			const probeStub = env.AGENT.get(env.AGENT.idFromName(`limits:${name}`))
			return probeStub.limits(name, url.search)
		}
		if (url.pathname === '/') {
			return new Response('GET /run?message=... | GET /bench?counts=100,500&stores=sqlite,file | GET /shell?cmd=... | GET /git?rounds=25 | GET /reap?events=1 | GET /limits\n', { status: 404 })
		}
		// Everything else is the SDK's own transport surface: /rpc, /health, /status, /sessions/*, /ws.
		return stub.fetch(request)
	},
} satisfies ExportedHandler<Env>
