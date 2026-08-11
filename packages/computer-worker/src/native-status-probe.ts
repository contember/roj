/**
 * What a `git status` would cost if it were asked of SQLite instead of of git.
 *
 * The cloned-repo measurement put `git status` at ~0.6 ms per filesystem node
 * with nothing to report — it is the tree walk that costs, not the hashing, and
 * a walk of 14,714 nodes through an async fs is 9.4 s. But that tree is rows in
 * the workspace's own SQLite, so the same walk is a recursive CTE. This times
 * three questions against it:
 *
 *   - enumerate every file under the worktree, with its revision
 *   - resolve the paths of every node that moved since a revision, in one query
 *   - confirm one moved path really differs from HEAD (hash vs the HEAD blob)
 *
 * Together they are the three parts a native status needs, so the numbers say
 * whether it can replace the git call outright or only shortcut it.
 */

import type { Workspace } from '@cloudflare/computer'
import type { Platform } from '@roj-ai/sdk/platform'

/** The `all` slice of `Workspace['db']`, structurally — rows are the schema's business. */
export interface SqlSource {
	all(query: string, ...bindings: unknown[]): unknown[]
}

export interface NativeStatusResult {
	/** Inode of the worktree directory, or null when it could not be located. */
	rootInode: number | null
	/** One recursive CTE that materialises every file path under the worktree. */
	enumMs: number
	enumFiles: number
	/** Revision the worktree stood at before the probe's writes. */
	revisionBefore: number | null
	/** Files rewritten to make the delta non-trivial. */
	touched: number
	touchMs: number
	/** The shipped port: one query per changed inode, plus a parent walk each. */
	deltaPortMs: number
	deltaPortPaths: number | null
	/** The same answer as a single upward CTE, so the scan cap can go. */
	deltaCteMs: number
	deltaCtePaths: number
	/** Do the two agree on the path set? */
	deltaAgrees: boolean | null
	/** `git status` over the same state — the number both are replacing. */
	statusMs: number
	statusEntries: number
	/** Hash candidates and compare each with the blob HEAD holds for that path. */
	verified: number
	verifyMs: number
	verifyDiffers: number
	verifyError?: string
	/** HEAD's own file list — what an exact index-vs-HEAD comparison would cost. */
	lsFilesMs: number
	lsFilesCount: number
	/** The same tree read recursively, so the blob oid of every path is known. */
	treeMs: number
	treeBlobs: number
	treeDirs: number
	treeError?: string
	/** The shipped native status against the binding it replaces, on a clean tree. */
	clean: StatusComparison
	/** The same pair after the probe's edits, an untracked file and an ignored one. */
	dirty: StatusComparison
	/** Repo-relative path of the file written into an ignored directory. */
	ignored: string | null
}

/** One question, asked of both implementations. */
export interface StatusComparison {
	nativeMs: number
	nativeEntries: number | null
	bindingMs: number
	bindingEntries: number
	/** Do the two report the same paths? Null when the native side declined. */
	agrees: boolean | null
	/** Paths one reported and the other did not, capped for readability. */
	nativeOnly?: string[]
	bindingOnly?: string[]
	error?: string
}

const ENUM_QUERY = `
WITH RECURSIVE tree(inode, path) AS (
	SELECT d.child_inode, d.name FROM vfs_dirents d WHERE d.parent_inode = ?1
	UNION ALL
	SELECT d.child_inode, t.path || '/' || d.name FROM vfs_dirents d JOIN tree t ON d.parent_inode = t.inode
)
SELECT t.path AS path, n.rev AS rev FROM tree t JOIN vfs_nodes n ON n.inode = t.inode WHERE n.type = 'file'
`

/** Every node past a revision, walked up to the worktree root — paths come out repo-relative. */
const DELTA_QUERY = `
WITH RECURSIVE up(orig, inode, path) AS (
	SELECT n.inode, n.inode, '' FROM vfs_nodes n WHERE n.rev > ?1 AND n.type = 'file'
	UNION ALL
	SELECT u.orig, d.parent_inode, '/' || d.name || u.path
	FROM up u JOIN vfs_dirents d ON d.child_inode = u.inode
	WHERE d.parent_inode <> u.inode
)
SELECT path AS path FROM up WHERE inode = ?2
`

const NAMED_QUERY = 'SELECT parent_inode AS parent, child_inode AS child FROM vfs_dirents WHERE name = ?'

const PARENT_QUERY = 'SELECT parent_inode AS parent FROM vfs_dirents WHERE child_inode = ? LIMIT 1'

/** Candidates hashed against HEAD, enough to price one and not enough to dominate the run. */
const VERIFY_SAMPLE = 25

/** Disagreeing paths reported verbatim; past a handful the pattern is already clear. */
const DIFF_SAMPLE = 10

/** Directories a site repository almost certainly ignores; the first that takes a write wins. */
const IGNORED_DIRS = ['node_modules', 'dist', '.astro', 'build'] as const

function stringField(row: unknown, key: string): string | undefined {
	if (typeof row !== 'object' || row === null || !(key in row)) return undefined
	const value = Reflect.get(row, key)
	return typeof value === 'string' ? value : undefined
}

function numberField(row: unknown, key: string): number | undefined {
	if (typeof row !== 'object' || row === null || !(key in row)) return undefined
	const value = Reflect.get(row, key)
	return typeof value === 'number' ? value : undefined
}

/**
 * Inode of a top-level directory: the one named `name` whose own parent is the
 * filesystem root, which is the row that names itself or names nothing.
 */
function topLevelInode(db: SqlSource, name: string): number | null {
	for (const row of db.all(NAMED_QUERY, name)) {
		const parent = numberField(row, 'parent')
		const child = numberField(row, 'child')
		if (parent === undefined || child === undefined) continue
		const above = db.all(PARENT_QUERY, parent)[0]
		const grandparent = above === undefined ? undefined : numberField(above, 'parent')
		if (grandparent === undefined || grandparent === parent) return child
	}
	return null
}

/**
 * The port's status against the binding's, on whatever the tree currently is.
 *
 * `platform.git` is the roj port, which answers from SQLite where it can;
 * `workspace.git` is the isomorphic-git binding it replaces. Both are asked the
 * same question, and the paths are compared rather than only the counts — two
 * implementations that disagree by one addition and one omission would otherwise
 * look identical.
 */
async function compareStatus(platform: Platform, workspace: Workspace, dir: string): Promise<StatusComparison> {
	try {
		await scheduler.wait(0)
		const nativeStart = Date.now()
		const native = await platform.git?.status({ dir })
		await scheduler.wait(0)
		const nativeMs = Date.now() - nativeStart

		const bindingStart = Date.now()
		const binding = await workspace.git.status({ dir })
		await scheduler.wait(0)
		const bindingMs = Date.now() - bindingStart

		if (native === undefined) {
			return { nativeMs, nativeEntries: null, bindingMs, bindingEntries: binding.length, agrees: null }
		}

		const nativePaths = new Set(native.map((entry) => entry.path))
		const bindingPaths = new Set(binding.map((entry) => entry.path))
		const nativeOnly = [...nativePaths].filter((path) => !bindingPaths.has(path))
		const bindingOnly = [...bindingPaths].filter((path) => !nativePaths.has(path))
		return {
			nativeMs,
			nativeEntries: native.length,
			bindingMs,
			bindingEntries: binding.length,
			agrees: nativeOnly.length === 0 && bindingOnly.length === 0,
			...(nativeOnly.length === 0 ? {} : { nativeOnly: nativeOnly.slice(0, DIFF_SAMPLE) }),
			...(bindingOnly.length === 0 ? {} : { bindingOnly: bindingOnly.slice(0, DIFF_SAMPLE) }),
		}
	} catch (error) {
		return {
			nativeMs: 0,
			nativeEntries: null,
			bindingMs: 0,
			bindingEntries: 0,
			agrees: null,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export async function runNativeStatusProbe(options: {
	platform: Platform
	workspace: Workspace
	db: SqlSource
	dir: string
	touch: number
}): Promise<NativeStatusResult> {
	const { platform, workspace, db, dir, touch } = options
	const rootInode = topLevelInode(db, dir.replace(/^\//, ''))
	const clean = await compareStatus(platform, workspace, dir)

	// workerd freezes its clock between I/O, so every reading is bracketed by a yield.
	await scheduler.wait(0)
	const enumStart = Date.now()
	const files = rootInode === null ? [] : db.all(ENUM_QUERY, rootInode)
	const paths: string[] = []
	for (const row of files) {
		const path = stringField(row, 'path')
		if (path !== undefined) paths.push(path)
	}
	await scheduler.wait(0)
	const enumMs = Date.now() - enumStart

	const revisionBefore = await platform.fsRevision?.current() ?? null

	// Rewrite real tracked files, so the delta is a delta git would also report.
	// `.git` is in the same tree and rewriting it destroys the repository.
	const targets = paths.filter((path) => path !== '.git' && !path.startsWith('.git/')).slice(0, touch)
	await scheduler.wait(0)
	const touchStart = Date.now()
	for (const path of targets) {
		await platform.fs.writeFile(`${dir}/${path}`, `roj-probe ${path}\n`)
	}
	await scheduler.wait(0)
	const touchMs = Date.now() - touchStart

	await scheduler.wait(0)
	const portStart = Date.now()
	const portChanges = revisionBefore === null
		? undefined
		: await platform.fsRevision?.changedSince(revisionBefore, { under: dir, limit: targets.length * 4 })
	await scheduler.wait(0)
	const deltaPortMs = Date.now() - portStart

	await scheduler.wait(0)
	const cteStart = Date.now()
	const cteRows = revisionBefore === null || rootInode === null ? [] : db.all(DELTA_QUERY, revisionBefore, rootInode)
	const ctePaths = new Set<string>()
	for (const row of cteRows) {
		const path = stringField(row, 'path')
		if (path !== undefined) ctePaths.add(path.replace(/^\//, ''))
	}
	await scheduler.wait(0)
	const deltaCteMs = Date.now() - cteStart

	const portPaths = portChanges === undefined
		? null
		: new Set(portChanges.map((change) => change.path.slice(dir.length + 1)))

	await scheduler.wait(0)
	const statusStart = Date.now()
	const status = await workspace.git.status({ dir })
	await scheduler.wait(0)
	const statusMs = Date.now() - statusStart

	const verification = await verifyCandidates(platform, workspace, dir, targets.slice(0, VERIFY_SAMPLE))
	const head = await readHeadTree(workspace, dir)

	// An untracked file and one the repository's own .gitignore covers, so the
	// comparison also exercises the half that has no index entry to lean on.
	await platform.fs.writeFile(`${dir}/roj-untracked.txt`, 'untracked\n')
	const ignored = await writeIgnored(platform, dir)
	const dirty = await compareStatus(platform, workspace, dir)

	return {
		rootInode,
		enumMs,
		enumFiles: paths.length,
		revisionBefore,
		touched: targets.length,
		touchMs,
		deltaPortMs,
		deltaPortPaths: portPaths === null ? null : portPaths.size,
		deltaCteMs,
		deltaCtePaths: ctePaths.size,
		deltaAgrees: portPaths === null ? null : sameSet(portPaths, ctePaths),
		statusMs,
		statusEntries: status.length,
		...verification,
		...head,
		clean,
		dirty,
		ignored,
	}
}

/**
 * A file under whichever directory the repository's own `.gitignore` covers.
 *
 * Returns the path written, so the comparison below can be read against it —
 * neither implementation should report it, and the one that does is wrong.
 */
async function writeIgnored(platform: Platform, dir: string): Promise<string | null> {
	for (const candidate of IGNORED_DIRS) {
		try {
			await platform.fs.mkdir(`${dir}/${candidate}`, { recursive: true })
			const path = `${candidate}/roj-ignored.txt`
			await platform.fs.writeFile(`${dir}/${path}`, 'ignored\n')
			return path
		} catch {
			// This repository does not have that directory; try the next candidate.
		}
	}
	return null
}

/**
 * What HEAD costs to read as a path list and as a path→oid map.
 *
 * The index says what is staged but not how that differs from HEAD, so an exact
 * status has to read HEAD's tree at least once per commit. This prices both
 * shapes of that read: the flat list isomorphic-git already walks for `ls-files`,
 * and the recursive `ls-tree` that also yields every blob's oid.
 */
async function readHeadTree(
	workspace: Workspace,
	dir: string,
): Promise<{ lsFilesMs: number; lsFilesCount: number; treeMs: number; treeBlobs: number; treeDirs: number; treeError?: string }> {
	try {
		await scheduler.wait(0)
		const listStart = Date.now()
		const listed = await workspace.git.lsFiles({ dir, ref: 'HEAD' })
		await scheduler.wait(0)
		const lsFilesMs = Date.now() - listStart

		const treeStart = Date.now()
		const oids = new Map<string, string>()
		let dirs = 0
		const stack = ['']
		while (stack.length > 0) {
			const prefix = stack.pop()
			if (prefix === undefined) break
			dirs += 1
			const entries = await workspace.git.lsTree({ dir, ref: 'HEAD', ...(prefix === '' ? {} : { path: prefix }) })
			for (const entry of entries) {
				const path = prefix === '' ? entry.path : `${prefix}/${entry.path}`
				if (entry.type === 'tree') stack.push(path)
				else oids.set(path, entry.oid)
			}
		}
		await scheduler.wait(0)
		return { lsFilesMs, lsFilesCount: listed.length, treeMs: Date.now() - treeStart, treeBlobs: oids.size, treeDirs: dirs }
	} catch (error) {
		return { lsFilesMs: 0, lsFilesCount: 0, treeMs: 0, treeBlobs: 0, treeDirs: 0, treeError: error instanceof Error ? error.message : String(error) }
	}
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false
	for (const value of a) {
		if (!b.has(value)) return false
	}
	return true
}

/**
 * The per-candidate half of a native status: hash what is on disk and compare it
 * with the blob HEAD holds for that path. This is what keeps the count exact —
 * a file rewritten with the bytes it already had moves the revision but is clean.
 */
async function verifyCandidates(
	platform: Platform,
	workspace: Workspace,
	dir: string,
	candidates: string[],
): Promise<{ verified: number; verifyMs: number; verifyDiffers: number; verifyError?: string }> {
	try {
		await scheduler.wait(0)
		const start = Date.now()
		const head = await workspace.git.revParse({ dir, ref: 'HEAD' })
		let differs = 0
		for (const path of candidates) {
			const blob = await workspace.git.catFile({ dir, oid: head, filepath: path })
			const bytes = await platform.fs.readFile(`${dir}/${path}`)
			const oid = await workspace.git.hashObject({ dir, content: bytes })
			if (oid !== blob.oid) differs += 1
		}
		await scheduler.wait(0)
		return { verified: candidates.length, verifyMs: Date.now() - start, verifyDiffers: differs }
	} catch (error) {
		return { verified: 0, verifyMs: 0, verifyDiffers: 0, verifyError: error instanceof Error ? error.message : String(error) }
	}
}
