/**
 * What a read scope over a whole worktree costs in memory.
 *
 * A scope keeps every listing it reads for as long as the operation runs, and
 * the operations roj now wraps in one — a recursive listing, a copy, a resource
 * scan — read the entire tree. That is the one change of the round that can
 * fail outright rather than merely be slow, so the size has to be a measured
 * number and not an estimate.
 *
 * Nothing inside a Worker isolate reports heap bytes: `process.memoryUsage()`
 * is a stub of zeroes and `performance.memory` is absent (see limits/memory.ts).
 * So the number is read from outside, over the inspector protocol, and this
 * probe's only job is to hold the isolate still in a known state long enough to
 * be sampled. Each still window is reported with the wall-clock it spanned, so
 * the samples can be lined up against it afterwards.
 */

import type { Platform } from '@roj-ai/sdk/platform'

export interface ScopeWindow {
	name: string
	/** Epoch ms the isolate stood idle in this state — the sampler matches on these. */
	startedAt: number
	endedAt: number
	/** Entries walked before the window opened, so a phase that did nothing is visible. */
	entries: number
}

export interface ScopeMemoryResult {
	dir: string
	/** Milliseconds each window idles, for the sampler to take a reading in. */
	holdMs: number
	windows: ScopeWindow[]
	notes: string[]
}

/** Every path under `dir`, as a scope-filling walk: a listing per directory, a stat per file. */
async function walk(platform: Platform, dir: string): Promise<number> {
	let entries = 0
	const stack = [dir]
	while (stack.length > 0) {
		const current = stack.pop()
		if (current === undefined) continue
		for (const entry of await platform.fs.readdir(current, { withFileTypes: true })) {
			const path = `${current}/${entry.name}`
			entries++
			if (entry.isDirectory()) stack.push(path)
			else await platform.fs.stat(path)
		}
	}
	return entries
}

export async function runScopeMemoryProbe(options: {
	platform: Platform
	dir: string
	holdMs: number
}): Promise<ScopeMemoryResult> {
	const { platform, dir, holdMs } = options
	const windows: ScopeWindow[] = []

	/** Stand still under `name` for holdMs, and report exactly when. */
	const hold = async (name: string, entries: number): Promise<void> => {
		await scheduler.wait(0)
		const startedAt = Date.now()
		await scheduler.wait(holdMs)
		windows.push({ name, startedAt, endedAt: Date.now(), entries })
	}

	// Before anything is walked: the floor every later reading is read against.
	await hold('idle', 0)

	// The same walk with no scope open. Its rows are garbage the moment each
	// call returns, so this window should read back at the floor — which is what
	// makes it the control for the one below.
	await hold('after walk, no scope', await walk(platform, dir))

	// The measurement: one scope kept open across the whole walk, held open
	// while the sampler reads, and only then closed.
	const scopeReads = platform.fs.scopeReads
	if (scopeReads === undefined) {
		await hold('scope open (unavailable)', 0)
	} else {
		await scopeReads(async () => {
			await hold('scope open', await walk(platform, dir))
		})
	}

	// After the scope closed: what it held is collectable again, so a reading
	// that stays high here is a leak rather than a working set.
	await hold('released', 0)

	return {
		dir,
		holdMs,
		windows,
		notes: [
			'sample from outside: HeapProfiler.collectGarbage, then Runtime.getHeapUsage, inside each window',
			'no counter exists in-isolate — process.memoryUsage() is a stub and performance.memory is absent',
		],
	}
}
