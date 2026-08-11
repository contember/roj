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

export interface CloneProbeResult {
	url: string
	ref?: string
	depth: number
	/** Wall clock for the clone call alone. */
	cloneMs: number
	/** Wall clock for the walk that produced `files` / `bytes`. */
	walkMs: number
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
}

interface WalkTotals {
	files: number
	dirs: number
	bytes: number
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
}): Promise<CloneProbeResult> {
	const { platform, workspace, url, dir, ref, depth, token, dbSize } = options

	const dbBytesBefore = dbSize?.()
	// workerd freezes its clock between I/O, so yield before reading it.
	await scheduler.wait(0)
	const cloneStart = Date.now()
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
	await scheduler.wait(0)
	const cloneMs = Date.now() - cloneStart
	const dbBytesAfter = dbSize?.()

	const walkStart = Date.now()
	const totals = await walk(platform, dir)
	await scheduler.wait(0)
	const walkMs = Date.now() - walkStart

	const result: CloneProbeResult = {
		url,
		ref,
		depth,
		cloneMs,
		walkMs,
		...totals,
		dbBytesBefore,
		dbBytesAfter,
		statusRunsMs: [],
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

	return result
}
