/**
 * Shared surface for the limit probes.
 *
 * Each probe under `src/limits/` answers one question about where roj stops
 * working inside a Worker isolate. They all get the same context so a probe
 * stays one file, and `/limits/<name>` routes to it.
 */

import type { Workspace } from '@cloudflare/computer'
import type { IsolateMethodSchemas, Services, System, isolatePlugins } from '@roj-ai/sdk'
import type { Platform } from '@roj-ai/sdk/platform'

/** The SDK's System narrowed to the plugin set the isolate profile registers. */
export type IsolateSystem = System<IsolateMethodSchemas, typeof isolatePlugins>

export interface Booted {
	services: Services<'isolate'>
	system: IsolateSystem
}

export interface LimitProbeContext {
	platform: Platform
	workspace: Workspace
	/** The DO's own state — `storage.sql` for row limits, `getWebSockets()` for sockets. */
	ctx: DurableObjectState
	/** Boots the SDK on first call, then memoised — same instance the rest of the DO uses. */
	boot: () => Booted
	/** Selector the shell backend is registered under. */
	backend: string
	/** Query string of the `/limits/<name>` request, so a probe can be tuned per run. */
	params: URLSearchParams
}

/** A probe returns whatever JSON best describes the ceiling it found. */
export type LimitProbe = (context: LimitProbeContext) => Promise<unknown>
