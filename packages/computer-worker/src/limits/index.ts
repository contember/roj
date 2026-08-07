/**
 * Registry of limit probes, keyed by the name `/limits/<name>` routes on.
 *
 * Probes are loaded lazily so one probe blowing up at module scope cannot take
 * the others — and the DO — down with it.
 */

import type { LimitProbe } from './context.js'

export const LIMIT_PROBES: Record<string, () => Promise<LimitProbe>> = {
	/** Isolate memory ceiling, in roj's own units: sessions, events, history size. */
	memory: async () => (await import('./memory.js')).memoryProbe,
	/** CPU and subrequests one agent turn costs, against the 30 s / 1000 budgets. */
	'turn-cost': async () => (await import('./turn-cost.js')).turnCostProbe,
	/** Size cliffs: DO SQLite column values, WebSocket frames, workspace files. */
	payload: async () => (await import('./payload.js')).payloadProbe,
	/** What one DO takes concurrently — parallel agents, live sessions, execs. */
	concurrency: async () => (await import('./concurrency.js')).concurrencyProbe,
	/** Whether the timer-driven agent loop survives a request returning. */
	lifecycle: async () => (await import('./lifecycle.js')).lifecycleProbe,
}

export const LIMIT_PROBE_NAMES = Object.keys(LIMIT_PROBES)
