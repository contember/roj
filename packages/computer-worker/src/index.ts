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
import { SqliteEventStore, createComputerPlatform, createShellProcessRunner } from '@roj-ai/computer-platform'
import { FileEventStore, bootstrap, createSystemFromServices, isolatePlugins } from '@roj-ai/sdk'
import type { Config, IsolateMethodSchemas, Services, Session, SessionId, System } from '@roj-ai/sdk'
import type { Platform } from '@roj-ai/sdk/platform'
import { DurableObject } from 'cloudflare:workers'
import { runBench } from './bench.js'
import type { BenchResult } from './bench.js'
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
		})
		this.#platform = {
			...createComputerPlatform(this.#workspace),
			// createComputerPlatform defaults to ENOSYS; this workspace has a shell to run on.
			process: createShellProcessRunner(this.#workspace, { backend: SHELL_BACKEND }),
		}
		this.#eventStore = new SqliteEventStore(storage)
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
		const booted = { services, system: createSystemFromServices(services) }
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

	async shell(command: string | null): Promise<Response> {
		try {
			return Response.json({ ok: true, ...await runShellProbes({ platform: this.#platform, workspace: this.#workspace, backend: SHELL_BACKEND, command }) })
		} catch (error) {
			return Response.json({ ok: false, ...describeError(error) }, { status: 500 })
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
		return new Response('GET /run?message=... | GET /bench?counts=100,500&stores=sqlite,file | GET /shell?cmd=...\n', { status: 404 })
	},
} satisfies ExportedHandler<Env>
