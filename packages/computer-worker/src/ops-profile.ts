/**
 * The same statement count, asked of every operation an agent actually runs.
 *
 * `git status` was the first one measured and the one the driver was tuned
 * against, which makes it exactly the wrong thing to judge the driver by. The
 * operations here are the rest of the working set — the git commands around a
 * commit, and the plain filesystem calls underneath them — each profiled the
 * same way so a shape that only one of them pays for cannot hide.
 *
 * Order matters: reads run before the writes that would invalidate them, and
 * the mutating operations run last because they leave the tree different from
 * how they found it.
 */

import type { Workspace } from '@cloudflare/computer'
import type { Platform } from '@roj-ai/sdk/platform'
import { profileSql } from './sql-profile.js'
import type { SqlProfile } from './sql-profile.js'

export interface OpProfile {
	name: string
	/** Wall clock for the operation alone. */
	ms: number
	/** What the operation produced, so a fast number that did nothing is visible. */
	result: string
	sql: SqlProfile
	error?: string
}

export interface OpsProfileOptions {
	platform: Platform
	workspace: Workspace
	/** The workspace database, wrapped for the duration of each operation. */
	db: Parameters<typeof profileSql>[0]
	/** Repository worktree, already cloned and dirty. */
	dir: string
	/** Files the write/read benchmarks touch. */
	sample?: number
}

/** Enough files for a per-file cost to show, few enough to stay off the critical path. */
const DEFAULT_SAMPLE = 50

/**
 * Every path under `dir`, walked one readdir at a time through the platform
 * port — what roj's own file listing does, with no read scope open.
 */
async function walkPlatform(platform: Platform, dir: string): Promise<number> {
	let files = 0
	const stack = [dir]
	while (stack.length > 0) {
		const current = stack.pop()
		if (current === undefined) continue
		for (const entry of await platform.fs.readdir(current, { withFileTypes: true })) {
			const path = `${current}/${entry.name}`
			if (entry.isDirectory()) stack.push(path)
			else files++
		}
	}
	return files
}

/**
 * The shape `listDirectoryRecursive` walks: a listing per directory and a stat
 * per file, because a Dirent carries no size. Measured with and without a read
 * scope, which is the only difference between the two entries below.
 */
async function walkWithSizes(platform: Platform, dir: string): Promise<number> {
	let bytes = 0
	const walk = async (current: string): Promise<void> => {
		for (const entry of await platform.fs.readdir(current, { withFileTypes: true })) {
			const path = `${current}/${entry.name}`
			if (entry.isDirectory()) await walk(path)
			else bytes += (await platform.fs.stat(path)).size
		}
	}
	await walk(dir)
	return bytes
}

/** The same walk over the workspace filesystem, whose readdir carries metadata. */
async function walkWorkspace(workspace: Workspace, dir: string): Promise<number> {
	let files = 0
	const stack = [dir]
	while (stack.length > 0) {
		const current = stack.pop()
		if (current === undefined) continue
		for (const entry of await workspace.fs.readdir(current)) {
			const path = `${current}/${entry.name}`
			if (entry.isDirectory) stack.push(path)
			else files++
		}
	}
	return files
}

export async function runOpsProfile(options: OpsProfileOptions): Promise<OpProfile[]> {
	const { platform, workspace, db, dir, sample = DEFAULT_SAMPLE } = options
	const profiles: OpProfile[] = []

	const measure = async (name: string, work: () => Promise<string>): Promise<void> => {
		await scheduler.wait(0)
		const start = Date.now()
		try {
			const { result, profile } = await profileSql(db, work)
			await scheduler.wait(0)
			profiles.push({ name, ms: Date.now() - start, result, sql: profile })
		} catch (error) {
			await scheduler.wait(0)
			profiles.push({
				name,
				ms: Date.now() - start,
				result: '',
				sql: { totalCalls: 0, totalRows: 0, wallMs: 0, shapes: [] },
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	// --- Reads ---------------------------------------------------------

	// First and last, because the two are not the same question: here HEAD is
	// the packfile the clone brought, at the end it is a commit this profile
	// wrote and whose tree objects are loose.
	await measure('git.status (packed HEAD)', async () => {
		const entries = await workspace.git.status({ dir })
		return `${entries.length} entries`
	})

	await measure('git.diffSummary', async () => {
		const entries = await workspace.git.diffSummary({ dir })
		return `${entries.length} entries`
	})

	await measure('git.log(20)', async () => {
		const commits = await workspace.git.log({ dir, depth: 20 })
		return `${commits.length} commits`
	})

	await measure('fs.walk (platform port)', async () => `${await walkPlatform(platform, dir)} files`)

	await measure('fs.walk (workspace readdir)', async () => `${await walkWorkspace(workspace, dir)} files`)

	await measure('fs.listRecursive (unscoped)', async () => `${await walkWithSizes(platform, dir)} bytes`)

	await measure('fs.listRecursive (scoped)', async () => {
		const run = (): Promise<number> => walkWithSizes(platform, dir)
		const bytes = await (platform.fs.scopeReads ? platform.fs.scopeReads(run) : run())
		return `${bytes} bytes`
	})

	await measure('fs.find **/*.ts', async () => {
		const found = await workspace.fs.find(dir, '**/*.ts')
		return `${found.length} entries`
	})

	await measure('fs.grep', async () => {
		const matches = await workspace.fs.grep('export', dir, { limit: 200, include: '*.ts' })
		return `${matches.length} matches`
	})

	const paths: string[] = []
	await measure(`fs.readFile x${sample}`, async () => {
		const found = await workspace.fs.find(dir, '**/*.ts', { limit: sample })
		let bytes = 0
		for (const entry of found) {
			paths.push(entry.path)
			bytes += (await platform.fs.readFile(entry.path)).length
		}
		return `${paths.length} files, ${bytes} bytes`
	})

	// --- Writes --------------------------------------------------------

	await measure(`fs.writeFile x${sample}`, async () => {
		for (let index = 0; index < sample; index++) {
			await platform.fs.writeFile(`${dir}/roj-ops-${index}.txt`, `probe ${index}\n`)
		}
		return `${sample} files`
	})

	await measure(`fs.writeFile x${sample} (overwrite)`, async () => {
		for (let index = 0; index < sample; index++) {
			await platform.fs.writeFile(`${dir}/roj-ops-${index}.txt`, `probe ${index} again\n`)
		}
		return `${sample} files`
	})

	await measure('git.add (all)', async () => {
		await workspace.git.add({ dir, paths: ['.'] })
		return 'staged'
	})

	await measure('git.commit', async () => {
		const commit = await workspace.git.commit({
			dir,
			message: 'probe: ops profile',
			author: { name: 'roj probe', email: 'probe@example.com' },
		})
		return typeof commit === 'string' ? commit : JSON.stringify(commit).slice(0, 60)
	})

	await measure(`fs.rm x${sample}`, async () => {
		for (let index = 0; index < sample; index++) {
			await platform.fs.rm(`${dir}/roj-ops-${index}.txt`)
		}
		return `${sample} files`
	})

	// Last, because a status refreshes the index stat cache and every op above
	// should see the tree the one before it left.
	await measure('git.status (loose HEAD)', async () => {
		const entries = await workspace.git.status({ dir })
		return `${entries.length} entries`
	})

	return profiles
}
