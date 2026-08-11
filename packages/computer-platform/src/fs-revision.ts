/**
 * FsRevision over a `@cloudflare/computer` workspace's own SQLite.
 *
 * dofs keeps a counter row in `vfs_meta` that every mutation bumps before it
 * touches a node — writes, deletes, renames, chmod alike — so a single primary-key
 * lookup answers "has anything changed" without walking the tree. Deletes are
 * covered by the counter itself, which is why `current()` does not read
 * `vfs_nodes.rev`: a delete lowers that column's maximum instead of raising it.
 *
 * `changedSince` answers the follow-up. Every write stamps the bumped counter
 * onto `vfs_nodes.rev`, and dofs indexes that column (`vfs_nodes_by_rev`) for
 * its own sync — the same cursor scan the push path runs once per pull. Deletes
 * leave no node, so they come from the `vfs_changes` tombstones instead, indexed
 * the same way. Names live one level up in `vfs_dirents`, so a changed inode
 * becomes a path by walking parents, which costs the depth of the tree rather
 * than its size.
 *
 * `vfs_*` is the package's private schema, not an API — it carries migrations
 * v1→v5 already — so this file is the only place that names it, and every failure
 * degrades to `undefined`. A host whose schema has moved keeps working; it just
 * recomputes, exactly like a host with no port.
 */

import type { ChangedSinceOptions, FsChange, FsRevision } from '@roj-ai/sdk/platform'

/**
 * The queries this needs, as a structural type — `Workspace['db']` satisfies it.
 * Rows are `unknown` because their shape is the installed schema's business, not ours.
 */
export interface VfsRevisionSource {
	one(query: string, ...bindings: unknown[]): unknown
	all(query: string, ...bindings: unknown[]): unknown[]
}

const REVISION_QUERY = "SELECT v FROM vfs_meta WHERE k = 'rev'"

/** Files only: a directory's mtime moving because a child was rewritten is not a change. */
const CHANGED_QUERY = "SELECT inode, rev FROM vfs_nodes WHERE rev > ? AND type = 'file' ORDER BY rev LIMIT ?"

const DELETED_QUERY = "SELECT path, rev FROM vfs_changes WHERE rev > ? AND op = 'delete' ORDER BY rev LIMIT ?"

const PARENT_QUERY = 'SELECT parent_inode, name FROM vfs_dirents WHERE child_inode = ? LIMIT 1'

/** A tree deeper than this is a cycle, and a cycle must not become an infinite loop. */
const MAX_DEPTH = 64

/** Rows scanned before the answer stops being cheaper than the recomputation it saves. */
const DEFAULT_LIMIT = 1000

function revisionOf(row: unknown): number | undefined {
	if (typeof row !== 'object' || row === null || !('v' in row)) return undefined
	return typeof row.v === 'number' ? row.v : undefined
}

function inodeOf(row: unknown): number | undefined {
	if (typeof row !== 'object' || row === null || !('inode' in row)) return undefined
	return typeof row.inode === 'number' ? row.inode : undefined
}

function pathOf(row: unknown): string | undefined {
	if (typeof row !== 'object' || row === null || !('path' in row)) return undefined
	return typeof row.path === 'string' ? row.path : undefined
}

function parentOf(row: unknown): { parent: number; name: string } | undefined {
	if (typeof row !== 'object' || row === null) return undefined
	if (!('parent_inode' in row) || !('name' in row)) return undefined
	if (typeof row.parent_inode !== 'number' || typeof row.name !== 'string') return undefined
	return { parent: row.parent_inode, name: row.name }
}

/**
 * Absolute path of an inode, or `undefined` when the walk does not reach a root.
 *
 * `parents` is scoped to one call: a batch of edits under one directory resolves
 * that directory once, so the query count is closer to the number of directories
 * touched than to the number of files.
 */
function resolvePath(db: VfsRevisionSource, inode: number, parents: Map<number, string>): string | undefined {
	/** Deepest first, so the path is built by unwinding it. */
	const chain: { inode: number; name: string }[] = []
	let current = inode
	let base: string | undefined

	for (let depth = 0; depth < MAX_DEPTH && base === undefined; depth++) {
		const cached = parents.get(current)
		if (cached !== undefined) {
			base = cached
			break
		}

		const row = parentOf(db.one(PARENT_QUERY, current))
		// Nothing names it, or it names itself: either way this is the root.
		if (row === undefined || row.parent === current) {
			base = '/'
			parents.set(current, '/')
			break
		}

		chain.push({ inode: current, name: row.name })
		current = row.parent
	}
	if (base === undefined) return undefined

	let path = base
	for (let index = chain.length - 1; index >= 0; index--) {
		const entry = chain[index]
		if (entry === undefined || entry.name === '') continue
		path = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`
		// Every ancestor resolved on the way is one the next inode in the batch
		// does not have to walk — a directory of edits costs one walk, not one each.
		parents.set(entry.inode, path)
	}
	return path
}

function under(path: string, root: string): boolean {
	if (root === '/' || root === '') return true
	const normalised = root.endsWith('/') ? root.slice(0, -1) : root
	return path === normalised || path.startsWith(`${normalised}/`)
}

export function createVfsRevision(db: VfsRevisionSource): FsRevision {
	return {
		async current(): Promise<number | undefined> {
			try {
				return revisionOf(db.one(REVISION_QUERY))
			} catch {
				// Table absent or reshaped. Deliberately not latched off: a failed lookup
				// costs a fraction of the read it gates, and the caller degrades correctly.
				return undefined
			}
		},

		async changedSince(since: number, options: ChangedSinceOptions = {}): Promise<FsChange[] | undefined> {
			const limit = options.limit ?? DEFAULT_LIMIT
			if (!Number.isSafeInteger(since) || since < 0 || limit <= 0) return undefined

			try {
				// One row over the cap is enough to know the scan was not exhaustive,
				// and stops a runaway batch from being materialised to find that out.
				const nodes = db.all(CHANGED_QUERY, since, limit + 1)
				if (nodes.length > limit) return undefined
				const deletes = db.all(DELETED_QUERY, since, limit + 1)
				if (deletes.length > limit) return undefined

				const root = options.under ?? '/'
				const parents = new Map<number, string>()
				const changes = new Map<string, FsChange>()

				for (const row of nodes) {
					const inode = inodeOf(row)
					if (inode === undefined) return undefined
					const path = resolvePath(db, inode, parents)
					if (path === undefined) continue
					if (!under(path, root)) continue
					changes.set(path, { path, deleted: false })
				}

				for (const row of deletes) {
					const path = pathOf(row)
					if (path === undefined) return undefined
					if (!under(path, root)) continue
					// A path written after it was deleted is live again; the node scan
					// carries the higher revision, so it wins.
					if (changes.has(path)) continue
					changes.set(path, { path, deleted: true })
				}

				return [...changes.values()]
			} catch {
				return undefined
			}
		},
	}
}
