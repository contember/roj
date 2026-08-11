/**
 * The working tree, read as rows instead of walked as a filesystem.
 *
 * A `git status` spends its time on metadata: one readdir and one lstat per
 * node, each an async round-trip into SQLite. Measured on a cloned site that
 * is ~0.6 ms per node, so 14,714 nodes answer in 9.4 s — with nothing to
 * report. The same tree is two tables, so the same walk is one recursive CTE:
 * 61 ms for 7,658 files, paths included.
 *
 * `.git` is pruned at the seed of the recursion rather than filtered out of the
 * result, so the object store — which is most of the node count — is never
 * visited at all.
 */

import { hasValue, numberField, stringField } from '../vfs-source.js'
import type { VfsSource } from '../vfs-source.js'

/** A chain longer than this is a cycle, and a cycle must not become a loop. */
const MAX_DEPTH = 64

/**
 * Past this the native answer stops being the cheap one, and the caller is
 * better served by the git binding it would otherwise have used.
 */
const MAX_FILES = 200_000

export interface VfsNode {
	type: string
	/** Milliseconds since the epoch, the same clock git's index records. */
	mtimeMs: number
	size: number
}

export interface WorktreeFile {
	/** Repo-relative, `/`-separated, no leading slash. */
	path: string
	size: number
	/** Milliseconds since the epoch, the same clock git's index records. */
	mtimeMs: number
	symlink: boolean
	/** Link target, for a symlink — git hashes this in place of file content. */
	target?: string
}

const ANY_DIRENT = 'SELECT child_inode AS inode FROM vfs_dirents LIMIT 1'
const PARENT_OF = 'SELECT parent_inode AS parent FROM vfs_dirents WHERE child_inode = ? LIMIT 1'
const CHILD_OF = 'SELECT child_inode AS inode FROM vfs_dirents WHERE parent_inode = ? AND name = ? LIMIT 1'
const NODE_OF = 'SELECT type AS type, mtime AS mtime, size AS size FROM vfs_nodes WHERE inode = ? LIMIT 1'

const WORKTREE_QUERY = `
WITH RECURSIVE tree(inode, type, path) AS (
	SELECT n.inode, n.type, d.name
	  FROM vfs_dirents d JOIN vfs_nodes n ON n.inode = d.child_inode
	 WHERE d.parent_inode = ?1 AND d.name <> '.git'
	UNION ALL
	SELECT n.inode, n.type, t.path || '/' || d.name
	  FROM tree t
	  JOIN vfs_dirents d ON d.parent_inode = t.inode
	  JOIN vfs_nodes n ON n.inode = d.child_inode
	 WHERE t.type = 'dir'
)
SELECT t.path AS path, t.type AS type, n.size AS size, n.mtime AS mtime, n.link_target AS target, n.mount_root AS mount
  FROM tree t JOIN vfs_nodes n ON n.inode = t.inode
 WHERE t.type <> 'dir'
 LIMIT ?2
`

/**
 * Inode of the filesystem root, found by walking up from an arbitrary entry.
 *
 * The schema does not name the root: it is the inode that either has no dirent
 * pointing at it or points at itself, which is the same rule the sync path uses.
 */
export function findRootInode(db: VfsSource): number | undefined {
	const seed = numberField(db.one(ANY_DIRENT), 'inode')
	if (seed === undefined) return undefined

	let current = seed
	for (let depth = 0; depth < MAX_DEPTH; depth++) {
		const parent = numberField(db.one(PARENT_OF, current), 'parent')
		if (parent === undefined || parent === current) return current
		current = parent
	}
	return undefined
}

/** Walk `path` down from `start`, a segment per lookup. `..` is refused, not resolved. */
export function resolveInode(db: VfsSource, start: number, path: string): number | undefined {
	let current = start
	for (const segment of path.split('/')) {
		if (segment === '' || segment === '.') continue
		if (segment === '..') return undefined
		const inode = numberField(db.one(CHILD_OF, current, segment), 'inode')
		if (inode === undefined) return undefined
		current = inode
	}
	return current
}

export function readNode(db: VfsSource, inode: number): VfsNode | undefined {
	const row = db.one(NODE_OF, inode)
	const type = stringField(row, 'type')
	const mtimeMs = numberField(row, 'mtime')
	const size = numberField(row, 'size')
	if (type === undefined || mtimeMs === undefined || size === undefined) return undefined
	return { type, mtimeMs, size }
}

/**
 * Every non-directory under `rootInode`, `.git` excluded.
 *
 * `undefined` where the answer cannot be trusted: a tree too large to be worth
 * reading this way, or one holding a mounted node, whose `size` is a stub's
 * rather than the file's.
 */
export function listWorktree(db: VfsSource, rootInode: number): WorktreeFile[] | undefined {
	const rows = db.all(WORKTREE_QUERY, rootInode, MAX_FILES + 1)
	if (rows.length > MAX_FILES) return undefined

	const files: WorktreeFile[] = []
	for (const row of rows) {
		if (hasValue(row, 'mount')) return undefined
		const path = stringField(row, 'path')
		const type = stringField(row, 'type')
		const size = numberField(row, 'size')
		const mtimeMs = numberField(row, 'mtime')
		if (path === undefined || type === undefined || size === undefined || mtimeMs === undefined) return undefined
		const target = stringField(row, 'target')
		files.push({ path, size, mtimeMs, symlink: type === 'symlink', ...(target === undefined ? {} : { target }) })
	}
	return files
}
