/**
 * What a real site repo costs to clone into the Durable Object's filesystem.
 *
 * The question this answers is whether a session can start from a shallow
 * clone inside the DO at all, or whether the tree has to arrive some other
 * way. Only the tip tree is fetched (`depth: 1`, `singleBranch`), which is
 * what an editing session needs — history stays on the remote.
 *
 * Times the clone, then walks what landed, so the wall-clock number can be
 * read against a file count and a byte count rather than on its own.
 */

import type { Workspace } from '@cloudflare/computer'
import type { Platform } from '@roj-ai/sdk/platform'
import { runNativeStatusProbe } from './native-status-probe.js'
import type { NativeStatusResult, SqlSource } from './native-status-probe.js'
import { runOpsProfile } from './ops-profile.js'
import type { OpProfile } from './ops-profile.js'
import { profileSql } from './sql-profile.js'
import type { SqlProfile } from './sql-profile.js'
import type { RawQuery } from './vfs-cost-probe.js'

export interface CloneProbeResult {
	url: string
	ref?: string
	depth: number
	/** Wall clock for the clone call alone. */
	cloneMs: number
	/** Wall clock for the walk that produced `files` / `bytes`. */
	walkMs: number
	/** The same walk over readdir's own metadata, with no stat per file (0.2.0+). */
	walkMetaMs?: number
	walkMetaFiles?: number
	walkMetaBytes?: number
	files: number
	dirs: number
	bytes: number
	/** DO SQLite size before and after, so the storage cost is visible. */
	dbBytesBefore?: number
	dbBytesAfter?: number
	/** Cost of one `git status` on the cloned tree — the agent's most common read. */
	statusMs?: number
	statusEntries?: number
	/** Three consecutive runs: the first may pay for a cold pack cache. */
	statusRunsMs: number[]
	/** Write one file, then ask for status — the loop a human is waiting on. */
	editWriteMs?: number
	/** The same edit answered from the filesystem revision instead of from git. */
	deltaMs?: number
	deltaPaths?: string[] | null
	statusAfterEditMs?: number
	statusAfterEditEntries?: number
	/** The same questions asked of SQLite instead of of git — see native-status-probe.ts. */
	native?: NativeStatusResult
	/** Every statement the clone itself ran — the write side of the driver. */
	cloneSql?: SqlProfile
	/** The rest of the working set, one statement count each — see ops-profile.ts. */
	ops?: OpProfile[]
}

interface WalkTotals {
	files: number
	dirs: number
	bytes: number
}

/**
 * The same traversal, but reading size off the directory listing instead of
 * asking for each file. 0.2.0's readdir returns size and mtime from the join it
 * already runs, so this is one statement per directory against the other walk's
 * one-plus-per-file.
 */
async function walkOverListing(workspace: Workspace, path: string): Promise<WalkTotals> {
	const totals: WalkTotals = { files: 0, dirs: 0, bytes: 0 }
	const stack = [path]
	while (stack.length > 0) {
		const dir = stack.pop()
		if (dir === undefined) break
		for (const entry of await workspace.fs.readdir(dir)) {
			if (entry.isDirectory) {
				totals.dirs++
				stack.push(`${dir}/${entry.name}`)
			} else {
				totals.files++
				totals.bytes += entry.size
			}
		}
	}
	return totals
}

async function walk(platform: Platform, path: string): Promise<WalkTotals> {
	const totals: WalkTotals = { files: 0, dirs: 0, bytes: 0 }
	const stack = [path]
	while (stack.length > 0) {
		const dir = stack.pop()
		if (dir === undefined) break
		const names = await platform.fs.readdir(dir)
		for (const name of names) {
			const child = `${dir}/${name}`
			const stats = await platform.fs.stat(child)
			if (stats.isDirectory()) {
				totals.dirs++
				stack.push(child)
			} else {
				totals.files++
				totals.bytes += stats.size
			}
		}
	}
	return totals
}

export async function runCloneProbe(options: {
	platform: Platform
	workspace: Workspace
	url: string
	dir: string
	ref?: string
	depth: number
	token?: string
	dbSize?: () => number | undefined
	/** Workspace SQLite, for the native-status half. Omit to skip it. */
	db?: SqlSource
	/** Files the native probe rewrites before measuring the delta. */
	touch?: number
	/** One statement against the DO's own SQL API, for the layer breakdown. */
	rawQuery?: RawQuery
	/** Passed to the ops profile — repeat its read half, and how far to overlap. */
	warm?: boolean
	overlap?: number
}): Promise<CloneProbeResult> {
	const { platform, workspace, url, dir, ref, depth, token, dbSize, db, touch, rawQuery, warm, overlap } = options

	const dbBytesBefore = dbSize?.()
	// workerd freezes its clock between I/O, so yield before reading it.
	await scheduler.wait(0)
	const cloneStart = Date.now()
	const runClone = async (): Promise<void> => {
		await workspace.git.clone({
			url,
			dir,
			depth,
			singleBranch: true,
			noTags: true,
			...(ref === undefined ? {} : { ref }),
			// Git-over-HTTPS wants Basic, not the Bearer the package README shows —
			// a Bearer header 401s even against a public repo.
			...(token === undefined ? {} : { headers: { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` } }),
		})
	}
	// The clone is the one operation that is mostly writes, so it is the one the
	// read scope cannot help — profile it to see what the write path costs.
	const cloneSql = db === undefined ? undefined : (await profileSql(workspace.db, runClone)).profile
	if (db === undefined) await runClone()
	await scheduler.wait(0)
	const cloneMs = Date.now() - cloneStart
	const dbBytesAfter = dbSize?.()

	const walkStart = Date.now()
	const totals = await walk(platform, dir)
	await scheduler.wait(0)
	const walkMs = Date.now() - walkStart

	const metaStart = Date.now()
	const metaTotals = await walkOverListing(workspace, dir)
	await scheduler.wait(0)
	const walkMetaMs = Date.now() - metaStart

	const result: CloneProbeResult = {
		url,
		ref,
		depth,
		cloneMs,
		walkMs,
		walkMetaMs,
		walkMetaFiles: metaTotals.files,
		walkMetaBytes: metaTotals.bytes,
		...totals,
		dbBytesBefore,
		dbBytesAfter,
		statusRunsMs: [],
		...(cloneSql === undefined ? {} : { cloneSql }),
	}

	// A clone that blew the invocation budget never gets here; one that didn't
	// still has to answer the question the agent asks constantly. Three runs,
	// because the first pays for the pack cache and the editing loop pays the rest.
	for (let round = 0; round < 3; round++) {
		const statusStart = Date.now()
		const status = await workspace.git.status({ dir })
		await scheduler.wait(0)
		result.statusMs = Date.now() - statusStart
		result.statusEntries = status.length
		result.statusRunsMs.push(result.statusMs)
	}

	// One edit, then the status the editor is waiting on — the actual feedback loop.
	const revisionBeforeEdit = await platform.fsRevision?.current()
	const editStart = Date.now()
	await platform.fs.writeFile(`${dir}/roj-probe.txt`, 'edit\n')
	await scheduler.wait(0)
	result.editWriteMs = Date.now() - editStart

	// The same question `git status` answers, asked of the filesystem instead:
	// what moved. Reported verbatim so the paths can be checked, not just timed.
	if (platform.fsRevision !== undefined && revisionBeforeEdit !== undefined) {
		const deltaStart = Date.now()
		const changes = await platform.fsRevision.changedSince(revisionBeforeEdit, { under: dir })
		await scheduler.wait(0)
		result.deltaMs = Date.now() - deltaStart
		result.deltaPaths = changes?.map((change) => (change.deleted ? `- ${change.path}` : change.path)) ?? null
	}

	const afterEditStart = Date.now()
	const afterEdit = await workspace.git.status({ dir })
	await scheduler.wait(0)
	result.statusAfterEditMs = Date.now() - afterEditStart
	result.statusAfterEditEntries = afterEdit.length

	// Runs last: it dirties the tree on purpose, so every measurement above is
	// taken against the tree the clone produced.
	if (db !== undefined) {
		result.native = await runNativeStatusProbe({
			platform,
			workspace,
			db,
			dir,
			touch: touch ?? 200,
			...(rawQuery === undefined ? {} : { rawQuery }),
		})
		// After the native probe, so `diff` and `commit` have a dirty tree to
		// work on rather than the pristine one the clone left.
		result.ops = await runOpsProfile({
			platform,
			workspace,
			db: workspace.db,
			dir,
			...(warm === undefined ? {} : { warm }),
			...(overlap === undefined ? {} : { overlap }),
		})
	}

	return result
}
