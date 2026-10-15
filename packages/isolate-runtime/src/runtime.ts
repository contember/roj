/**
 * The Roj runtime for a Durable Object that runs untrusted app code.
 *
 * Everything persistent lives in the object's own SQLite: the kompjutr filesystem,
 * the event log, the LLM call log and the wake rows. Everything else comes from
 * {@link RuntimeHost}, the only capability the object holds. Outbound `fetch`
 * goes wherever the host routed the isolate's global outbound, which is where
 * provider keys and tool credentials are added — the runtime never holds them.
 *
 * It answers the same HTTP surface as the sandbox runtime (`/rpc`, `/status`,
 * `/sessions/*`), so a host can reuse its sandbox client. Requests reach it only
 * through the host, which authenticates the caller and stamps `_caller`.
 */

import { type DurableObjectStorageLike, Workspace } from '@kompjutr/do'
import { createKompjutrPlatform, KompjutrEventStore } from '@roj-ai/kompjutr-platform'
import { bootstrap, createSystemFromServices } from '@roj-ai/sdk'
import type { Config, RojConfig } from '@roj-ai/sdk'
import { createApp } from '@roj-ai/sdk/transport/http/app'
import { createAlarmScheduler, type AlarmSchedulerStats, type SyncKvLike } from './alarm-scheduler.js'
import type { RuntimeHost } from './host-contract.js'
import { ISOLATE_RUNTIME_NAME, ISOLATE_RUNTIME_VERSION } from './info.js'

/** The parts of `DurableObjectState` the runtime uses. */
export interface IsolateRuntimeState {
	storage: DurableObjectStorageLike & { kv: SyncKvLike }
	waitUntil(promise: Promise<unknown>): void
}

export interface IsolateRuntimeOptions {
	userConfig: RojConfig
	host: RuntimeHost
	state: IsolateRuntimeState
	/** Overrides of the built-in config, e.g. `llmMock` in tests. */
	config?: Partial<Config>
	/** See `AlarmSchedulerHost.inFlightRetryMs`. */
	inFlightRetryMs?: number
}

export interface IsolateRuntime {
	/**
	 * Loads open sessions, which recovers agents an eviction left mid-turn. Await before serving.
	 * It never waits on the host: a facet runs it in `blockConcurrencyWhile`, and the parent cannot
	 * answer the facet until that ends. The alarm writes it queues settle in the next `fetch` or `deliverWakes`.
	 */
	start(): Promise<void>
	fetch(request: Request): Promise<Response>
	/** Call from the host's `alarm()`. Returns the wake keys delivered. */
	deliverWakes(): Promise<string[]>
	schedulerStats(): AlarmSchedulerStats
}

const DATA_ROOT = '/data'

/**
 * Stands in for the provider key, so the SDK's key check passes. The host's
 * egress replaces the authorization header on provider requests.
 */
export const EGRESS_PROVIDED_KEY = 'provided-by-host-egress'

export function createIsolateRuntime(options: IsolateRuntimeOptions): IsolateRuntime {
	const { state, host } = options
	// `loadConfig()` reads process.env and the cwd, which an isolate has neither of.
	const config: Config = {
		port: 0,
		host: 'localhost',
		dataPath: DATA_ROOT,
		persistence: 'memory',
		logLevel: 'warn',
		logFormat: 'json',
		llmLoggingEnabled: true,
		openRouterApiKey: EGRESS_PROVIDED_KEY,
		agentRuntime: { name: ISOLATE_RUNTIME_NAME, version: ISOLATE_RUNTIME_VERSION },
		...options.config,
	}

	const workspace = new Workspace({ storage: state.storage })
	workspace.filesystem.mkdir(DATA_ROOT, { recursive: true })
	const scheduler = createAlarmScheduler({
		storage: {
			kv: state.storage.kv,
			setAlarm: scheduledTime => host.setAlarm(scheduledTime),
			deleteAlarm: () => host.deleteAlarm(),
		},
		waitUntil: promise => state.waitUntil(promise),
		inFlightRetryMs: options.inFlightRetryMs,
	})
	const services = bootstrap(config, options.userConfig, createKompjutrPlatform(workspace, { scheduler }), {
		pluginProfile: 'isolate',
		eventStore: new KompjutrEventStore(workspace.db),
	})
	const system = createSystemFromServices(services, {
		onUserOutput: notification => {
			state.waitUntil(host.broadcast({ type: notification.type, payload: notification.payload, ts: Date.now() }))
		},
	})
	const app = createApp({ ...services, sessionRuntime: system.sessionManager })

	return {
		async start() {
			await system.sessionManager.loadAllSessions()
		},

		async fetch(request) {
			const response = await app.fetch(request)
			await scheduler.flush()
			return response
		},

		async deliverWakes() {
			const keys = await scheduler.deliverDue(key => system.sessionManager.dispatchWake(key))
			await scheduler.flush()
			return keys
		},

		schedulerStats: () => scheduler.stats(),
	}
}
