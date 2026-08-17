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
 * how they found it. The read half runs twice, because a first run pays for
 * caches a second one inherits and only the pair says which is which.
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
	/** Repeat the read half, so what a second run inherits is visible. */
	warm?: boolean
	/** Copies of one walk in the overlap pair. Zero skips it. */
	overlap?: number
}

/** Enough files for a per-file cost to show, few enough to stay off the critical path. */
const DEFAULT_SAMPLE = 50

/** Enough concurrent walks for sharing to show, few enough to stay inside one request. */
const DEFAULT_OVERLAP = 3

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

/** One measured operation, named and appended to the run's profile list. */
type Measure = (name: string, work: () => Promise<string>) => Promise<void>

export async function runOpsProfile(options: OpsProfileOptions): Promise<OpProfile[]> {
	const { platform, workspace, db, dir, sample = DEFAULT_SAMPLE, warm = true, overlap = DEFAULT_OVERLAP } = options
	const profiles: OpProfile[] = []

	const measure: Measure = async (name, work) => {
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

	/** The same walk every overlap entry runs, scoped where the platform offers one. */
	const scopedWalk = (): Promise<number> => {
		const run = (): Promise<number> => walkWithSizes(platform, dir)
		return platform.fs.scopeReads ? platform.fs.scopeReads(run) : run()
	}

	// --- Reads ---------------------------------------------------------
	//
	// Run whole rather than op by op, so the warm pass repeats exactly what the
	// cold one did. `suffix` is the only difference between the two calls.
	const reads = async (suffix: string): Promise<void> => {
		// First and last, because the two are not the same question: here HEAD is
		// the packfile the clone brought, at the end it is a commit this profile
		// wrote and whose tree objects are loose.
		await measure(`git.status (packed HEAD)${suffix}`, async () => {
			const entries = await workspace.git.status({ dir })
			return `${entries.length} entries`
		})

		await measure(`git.diffSummary${suffix}`, async () => {
			const entries = await workspace.git.diffSummary({ dir })
			return `${entries.length} entries`
		})

		await measure(`git.log(20)${suffix}`, async () => {
			const commits = await workspace.git.log({ dir, depth: 20 })
			return `${commits.length} commits`
		})

		// Both walks are controls, not something roj does: they open no scope, which
		// is what the pair below is here to price. WorkspaceFilesystem.readdir opens
		// none either, deliberately — a single listing has nothing to share, so the
		// caller doing the walking is the one that has to say so.
		await measure(
			`fs.walk (platform port, no scope)${suffix}`,
			async () => `${await walkPlatform(platform, dir)} files`,
		)

		await measure(
			`fs.walk (workspace readdir, no scope)${suffix}`,
			async () => `${await walkWorkspace(workspace, dir)} files`,
		)

		await measure(`fs.listRecursive (unscoped)${suffix}`, async () => `${await walkWithSizes(platform, dir)} bytes`)

		await measure(`fs.listRecursive (scoped)${suffix}`, async () => `${await scopedWalk()} bytes`)

		// The same answer asked for as one question. Nothing to scope and nothing
		// to remember: the platform walks it or it does not.
		await measure(`fs.walk (platform verb)${suffix}`, async () => {
			if (platform.fs.walk === undefined) return 'unavailable'
			const entries = await platform.fs.walk(dir)
			let bytes = 0
			for (const entry of entries) bytes += entry.size
			return `${entries.length} entries, ${bytes} bytes`
		})

		await measure(`fs.find **/*.ts${suffix}`, async () => {
			const found = await workspace.fs.find(dir, '**/*.ts')
			return `${found.length} entries`
		})

		await measure(`fs.grep${suffix}`, async () => {
			const matches = await workspace.fs.grep('export', dir, { limit: 200, include: '*.ts' })
			return `${matches.length} matches`
		})

		await measure(`fs.readFile x${sample}${suffix}`, async () => {
			const found = await workspace.fs.find(dir, '**/*.ts', { limit: sample })
			let bytes = 0
			for (const entry of found) bytes += (await platform.fs.readFile(entry.path)).length
			return `${found.length} files, ${bytes} bytes`
		})

		// The same bytes asked for as one question.
		await measure(`fs.readFiles x${sample} (platform verb)${suffix}`, async () => {
			if (platform.fs.readFiles === undefined) return 'unavailable'
			const found = await workspace.fs.find(dir, '**/*.ts', { limit: sample })
			const entries = await platform.fs.readFiles(found.map((entry) => entry.path))
			let bytes = 0
			for (const entry of entries) bytes += entry.content?.length ?? 0
			return `${entries.length} files, ${bytes} bytes`
		})
	}

	await reads('')
	if (warm) await reads(' (warm)')

	// --- Overlap -------------------------------------------------------
	//
	// Read scopes count rather than nest, so requests that overlap in one DO
	// share whichever scope is already open instead of each building its own.
	// The pair below is what that is worth: the same walks, started together and
	// started one after another, differing in nothing else.
	if (overlap > 0) {
		await measure(`fs.listRecursive x${overlap} (sequential)`, async () => {
			const results: number[] = []
			for (let index = 0; index < overlap; index++) results.push(await scopedWalk())
			return `${results.length} walks, ${new Set(results).size} distinct results`
		})

		await measure(`fs.listRecursive x${overlap} (concurrent)`, async () => {
			const results = await Promise.all(Array.from({ length: overlap }, () => scopedWalk()))
			return `${results.length} walks, ${new Set(results).size} distinct results`
		})

		// Different operations rather than copies of one, because they open their
		// scopes at different depths of the tree and finish out of order.
		await measure('fs.walk+find+grep (concurrent)', async () => {
			const [bytes, found, matches] = await Promise.all([
				scopedWalk(),
				workspace.fs.find(dir, '**/*.ts'),
				workspace.fs.grep('export', dir, { limit: 200, include: '*.ts' }),
			])
			return `${bytes} bytes, ${found.length} entries, ${matches.length} matches`
		})
	}

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

	// The same writes as one operation, so one batch settles rather than fifty.
	await measure(`fs.writeFiles x${sample} (platform verb)`, async () => {
		if (platform.fs.writeFiles === undefined) return 'unavailable'
		await platform.fs.writeFiles(
			Array.from({ length: sample }, (_, index) => ({
				path: `${dir}/roj-ops-set-${index}.txt`,
				content: `probe ${index}\n`,
			})),
		)
		return `${sample} files`
	})
	// Cleared outside the measurement, so the git ops below see the same tree
	// they saw before this op existed.
	for (let index = 0; index < sample; index++) {
		await platform.fs.rm(`${dir}/roj-ops-set-${index}.txt`, { force: true })
	}

	// Outside `dir`, so the copy is not something the git ops below have to see.
	// The walk that proves the copy landed runs after the measurement, not inside
	// it: counting a whole tree is dearer than the copy and would drown it.
	const copyOf = `${dir}-copy`
	let copied = 0
	await measure('fs.cp -r (subtree)', async () => {
		await platform.fs.cp(dir, copyOf, { recursive: true })
		return 'copied'
	})
	copied = await walkPlatform(platform, copyOf)
	const copy = profiles.find((profile) => profile.name === 'fs.cp -r (subtree)')
	if (copy !== undefined) copy.result = `${copied} files`

	await measure('fs.rm -r (subtree)', async () => {
		await platform.fs.rm(copyOf, { recursive: true, force: true })
		return (await platform.fs.exists(copyOf)) ? 'still there' : 'gone'
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
