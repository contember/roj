/**
 * Where the 0.7 ms a filesystem node costs actually goes.
 *
 * A readdir-and-stat walk of a cloned site takes ~10 s; the same tree comes out
 * of one recursive CTE in 61 ms. That is ~90x per node and the question is what
 * the 90 is made of — the number of SQL statements, the cost of a statement, or
 * the async boundary each call crosses.
 *
 * So each layer is timed on its own, against the tree a real clone produced:
 *
 *   awaitUs      an await that does nothing — the microtask floor
 *   rawSqlUs     one primary-key lookup straight off the Durable Object's SQL API
 *   dbOneUs      the same lookup through the workspace's Database wrapper
 *   cteRowUs     one row's share of a bulk recursive CTE
 *   lstatWarmUs  provider.lstat on one path, over and over
 *   lstatColdUs  provider.lstat over distinct paths, as a walk sees them
 *   statUs       platform.fs.stat — lstat plus this package's adapter
 *   readdirUs    provider.readdir on a directory
 *
 * Every phase is bracketed by a scheduler yield: workerd freezes its clock
 * between I/O, so a synchronous loop measures zero without one.
 */

import type { Workspace } from '@cloudflare/computer'
import type { Platform } from '@roj-ai/sdk/platform'
import type { SqlSource } from './native-status-probe.js'

/** Runs one statement against the DO's SQL API and reports how many rows came back. */
export type RawQuery = (inode: number) => number

export interface VfsCostResult {
	samples: number
	awaitUs: number
	rawSqlUs: number | null
	dbOneUs: number
	cteRowUs: number
	lstatWarmUs: number
	lstatColdUs: number
	statUs: number
	readdirUs: number
	/** Directories the readdir phase visited, and entries they held between them. */
	readdirDirs: number
	readdirEntries: number
	error?: string
}

const NODE_QUERY = 'SELECT size FROM vfs_nodes WHERE inode = ? LIMIT 1'

const INODE_QUERY = `
WITH RECURSIVE tree(inode, type) AS (
	SELECT n.inode, n.type FROM vfs_dirents d JOIN vfs_nodes n ON n.inode = d.child_inode WHERE d.parent_inode = ?1
	UNION ALL
	SELECT n.inode, n.type FROM tree t
	  JOIN vfs_dirents d ON d.parent_inode = t.inode
	  JOIN vfs_nodes n ON n.inode = d.child_inode
	 WHERE t.type = 'dir'
)
SELECT inode AS inode FROM tree WHERE type = 'file' LIMIT ?2
`

const BULK_QUERY = 'SELECT inode AS inode, size AS size FROM vfs_nodes WHERE type = \'file\' LIMIT ?'

function numberField(row: unknown, key: string): number | undefined {
	if (typeof row !== 'object' || row === null || !(key in row)) return undefined
	const value = Reflect.get(row, key)
	return typeof value === 'number' ? value : undefined
}

/** Microseconds per iteration, with the clock made to move on either side. */
async function timePer(iterations: number, run: () => void | Promise<void>): Promise<number> {
	await scheduler.wait(0)
	const start = Date.now()
	await run()
	await scheduler.wait(0)
	return ((Date.now() - start) * 1000) / iterations
}

export async function runVfsCostProbe(options: {
	platform: Platform
	workspace: Workspace
	db: SqlSource
	rootInode: number
	dir: string
	/** Repo-relative paths from the tree listing, used as distinct stat targets. */
	paths: readonly string[]
	samples: number
	rawQuery?: RawQuery
}): Promise<VfsCostResult> {
	const { platform, workspace, db, rootInode, dir, paths, samples, rawQuery } = options
	const provider = workspace.provider()

	// Real inodes to look up, so the queries hit rows that exist.
	const inodes: number[] = []
	for (const row of db.all(INODE_QUERY, rootInode, samples)) {
		const inode = numberField(row, 'inode')
		if (inode !== undefined) inodes.push(inode)
	}
	if (inodes.length === 0) {
		return {
			samples: 0,
			awaitUs: 0,
			rawSqlUs: null,
			dbOneUs: 0,
			cteRowUs: 0,
			lstatWarmUs: 0,
			lstatColdUs: 0,
			statUs: 0,
			readdirUs: 0,
			readdirDirs: 0,
			readdirEntries: 0,
			error: 'no file inodes under the worktree',
		}
	}

	const count = inodes.length
	const targets = paths.slice(0, count).map((path) => `${dir}/${path}`)
	const first = targets[0] ?? dir

	const awaitUs = await timePer(count, async () => {
		for (let i = 0; i < count; i++) await Promise.resolve()
	})

	const rawSqlUs = rawQuery === undefined ? null : await timePer(count, () => {
		for (const inode of inodes) rawQuery(inode)
	})

	const dbOneUs = await timePer(count, () => {
		for (const inode of inodes) db.one(NODE_QUERY, inode)
	})

	// One statement for the whole set, so the per-row figure carries only the
	// share of the statement's own cost plus materialising a row.
	const cteRowUs = await timePer(count, () => {
		db.all(BULK_QUERY, count)
	})

	const lstatWarmUs = await timePer(count, async () => {
		for (let i = 0; i < count; i++) await provider.lstat(first)
	})

	const lstatColdUs = await timePer(targets.length, async () => {
		for (const path of targets) await provider.lstat(path)
	})

	const statUs = await timePer(targets.length, async () => {
		for (const path of targets) await platform.fs.stat(path)
	})

	// Directories the paths sit in, deduplicated — a walk reads each one once.
	const dirs = [...new Set(targets.map((path) => path.slice(0, path.lastIndexOf('/'))))]
	let entries = 0
	const readdirUs = await timePer(dirs.length, async () => {
		for (const path of dirs) entries += (await provider.readdir(path)).length
	})

	return {
		samples: count,
		awaitUs,
		rawSqlUs,
		dbOneUs,
		cteRowUs,
		lstatWarmUs,
		lstatColdUs,
		statUs,
		readdirUs,
		readdirDirs: dirs.length,
		readdirEntries: entries,
	}
}
