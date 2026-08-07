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
import { SqliteEventStore, createComputerPlatform, createShellProcessRunner } from '@roj-ai/computer-platform'
import { FileEventStore, bootstrap, createSystemFromServices, isolatePlugins } from '@roj-ai/sdk'
import type { Config, IsolateMethodSchemas, Services, Session, SessionId, System } from '@roj-ai/sdk'
import type { Platform } from '@roj-ai/sdk/platform'
import { DurableObject } from 'cloudflare:workers'
import { runBench } from './bench.js'
import type { BenchResult } from './bench.js'
import { createDoTransport } from './do-transport.js'
import type { DoTransport } from './do-transport.js'
import { LIMIT_PROBES, LIMIT_PROBE_NAMES } from './limits/index.js'
import { NOTE_PATH, scriptedHandler } from './mock-llm.js'
import { isolatePreset } from './preset.js'
import { runShellProbes } from './shell-probe.js'

/** The SDK's System narrowed to the plugin set the isolate profile registers. */
type IsolateSystem = System<IsolateMethodSchemas, typeof isolatePlugins>

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
	readonly #transport: DoTransport
	/** Everything plugins have notified since boot — how /git observes git-status. */
	readonly #notifications: { type: string; payload: unknown }[] = []
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
		this.#platform = {
			...createComputerPlatform(this.#workspace),
			// createComputerPlatform defaults to ENOSYS; this workspace has a shell to run on.
			process: createShellProcessRunner(this.#workspace, { backend: SHELL_BACKEND }),
		}
		this.#eventStore = new SqliteEventStore(storage)
		this.#transport = createDoTransport(ctx, () => this.#boot())
	}

	fetch(request: Request): Promise<Response> {
		return this.#transport.fetch(request)
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
				this.#transport.broadcast(notification)
			},
		})
		const booted = { services, system }
		this.#booted = booted
		return booted
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
	 * and through the `git-status` plugin's polled notification.
	 */
	async git(): Promise<Response> {
		const { system } = this.#boot()
		const created = await system.sessionManager.createSession(isolatePreset.id)
		if (!created.ok) {
			return Response.json({ ok: false, stage: 'createSession', error: created.error }, { status: 500 })
		}
		const session = created.value
		const workdir = `/workspace/${session.id}`

		try {
			// git-status' first tick lands before any of this — an empty workspace is
			// the "no repository yet" case, which must stay quiet rather than warn.
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

			const snapshot = await this.#awaitGitStatus()
			return Response.json({ ok: true, sessionId: String(session.id), workdir, shell, port, snapshot })
		} catch (error) {
			return Response.json({ ok: false, ...describeError(error) }, { status: 500 })
		}
	}

	/** git-status polls every 2s, so give it a couple of ticks to see the new repo. */
	async #awaitGitStatus(timeoutMs = 10_000): Promise<unknown> {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const latest = this.#notifications.filter((entry) => entry.type === 'git_status_changed').at(-1)
			if (latest) return latest.payload
			await scheduler.wait(250)
		}
		return null
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
			return stub.git()
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
			return new Response('GET /run?message=... | GET /bench?counts=100,500&stores=sqlite,file | GET /shell?cmd=... | GET /git | GET /limits\n', { status: 404 })
		}
		// Everything else is the SDK's own transport surface: /rpc, /health, /status, /sessions/*, /ws.
		return stub.fetch(request)
	},
} satisfies ExportedHandler<Env>
