/**
 * Shared surface for the limit probes.
 *
 * Each probe under `src/limits/` answers one question about where roj stops
 * working inside a Worker isolate. They all get the same context so a probe
 * stays one file, and `/limits/<name>` routes to it.
 */

import type { Workspace } from '@cloudflare/computer'
import type { AlarmScheduler, SessionReaper } from '@roj-ai/computer-platform'
import type { IsolateMethodSchemas, Services, System, isolatePlugins } from '@roj-ai/sdk'
import type { Platform } from '@roj-ai/sdk/platform'

/** The SDK's System narrowed to the plugin set the isolate profile registers. */
export type IsolateSystem = System<IsolateMethodSchemas, typeof isolatePlugins>

export interface Booted {
	services: Services<'isolate'>
	system: IsolateSystem
}

/** One alarm the DO served: which wakes it drained, and what dispatching them threw. */
export interface WakeLogEntry {
	at: number
	keys: string[]
	errors?: string[]
}

export interface LimitProbeContext {
	platform: Platform
	workspace: Workspace
	/** The DO's own state — `storage.sql` for row limits, `getWebSockets()` for sockets. */
	ctx: DurableObjectState
	/** Boots the SDK on first call, then memoised — same instance the rest of the DO uses. */
	boot: () => Booted
	/** The alarm slot the agent loop's wakes ride on. */
	scheduler: AlarmScheduler
	/** Reclaims closed sessions. The DO's own — a probe cannot widen what it may delete. */
	reaper: SessionReaper
	/**
	 * Drops the booted SDK as an eviction would. `keepWakes` suspends the scheduler
	 * across the teardown, so `SessionManager.shutdown()` cannot cancel pending
	 * wakes. Returns false when nothing was booted to drop.
	 */
	evictSdk: (keepWakes: boolean) => Promise<boolean>
	/** Alarms this isolate has served, oldest first. */
	wakeLog: () => readonly WakeLogEntry[]
	/** Selector the shell backend is registered under. */
	backend: string
	/** Query string of the `/limits/<name>` request, so a probe can be tuned per run. */
	params: URLSearchParams
}

/** A probe returns whatever JSON best describes the ceiling it found. */
export type LimitProbe = (context: LimitProbeContext) => Promise<unknown>
