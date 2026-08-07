/**
 * Durable Object harness: the roj SDK running inside a Worker isolate,
 * against a @cloudflare/computer workspace filesystem.
 *
 * `GET /run` boots the SDK through its normal composition root, runs a
 * two-agent session on a scripted LLM, and reports what landed in the workspace.
 * `GET /bench` measures how session replay scales with event-log length.
 */

import { Workspace } from '@cloudflare/computer'
import type { DurableObjectStorageLike } from '@cloudflare/computer'
import { createComputerPlatform } from '@roj-ai/computer-platform'
import { bootstrap, createSystemFromServices } from '@roj-ai/sdk'
import type { Config, Services, Session } from '@roj-ai/sdk'
import type { Platform } from '@roj-ai/sdk/platform'

type BootedSystem = ReturnType<typeof createSystemFromServices>
import { DurableObject } from 'cloudflare:workers'
import { runBench } from './bench.js'
import { NOTE_PATH, scriptedHandler } from './mock-llm.js'
import { isolatePreset } from './preset.js'

interface Env {
	AGENT: DurableObjectNamespace<RojAgentDO>
}

/** Roj writes sessions, events and agent files below this root in the workspace. */
const DATA_ROOT = '/data'

/** `loadConfig()` reads process.env/cwd, which a Worker isolate has neither of. */
const config: Config = {
	port: 0,
	host: 'localhost',
	dataPath: DATA_ROOT,
	persistence: 'file',
	logLevel: 'info',
	logFormat: 'json',
	llmMock: scriptedHandler,
}

export class RojAgentDO extends DurableObject<Env> {
	readonly #workspace: Workspace
	readonly #platform: Platform
	#booted?: { services: Services; system: BootedSystem }

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		// computer types exec<Row extends object>, workers-types exec<T extends
		// Record<string, SqlStorageValue>> — the param is phantom at runtime.
		this.#workspace = new Workspace({ storage: ctx.storage as unknown as DurableObjectStorageLike })
		this.#platform = createComputerPlatform(this.#workspace)
	}

	#boot(): { services: Services; system: BootedSystem } {
		const existing = this.#booted
		if (existing) return existing
		const services = bootstrap(config, { presets: [isolatePreset] }, this.#platform)
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

	async bench(counts: number[]): Promise<Response> {
		const { services } = this.#boot()
		try {
			const result = await runBench({ services, platform: this.#platform, presetId: isolatePreset.id, counts })
			return Response.json({ ok: true, ...result })
		} catch (error) {
			return Response.json({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			}, { status: 500 })
		}
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
			return stub.bench(counts)
		}
		return new Response('GET /run?message=... | GET /bench?counts=100,500\n', { status: 404 })
	},
} satisfies ExportedHandler<Env>
