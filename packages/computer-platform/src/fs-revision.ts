/**
 * FsRevision over a `@cloudflare/computer` workspace's own SQLite.
 *
 * dofs keeps a counter row in `vfs_meta` that every mutation bumps before it
 * touches a node — writes, deletes, renames, chmod alike — so a single primary-key
 * lookup answers "has anything changed" without walking the tree. Deletes are
 * covered by the counter itself, which is why nothing here reads `vfs_nodes.rev`:
 * a delete lowers that column's maximum instead of raising it.
 *
 * `vfs_*` is the package's private schema, not an API — it carries migrations
 * v1→v5 already — so this file is the only place that names it, and every failure
 * degrades to `undefined`. A host whose schema has moved keeps working; it just
 * recomputes, exactly like a host with no port.
 */

import type { FsRevision } from '@roj-ai/sdk/platform'

/**
 * The one query this needs, as a structural type — `Workspace['db']` satisfies it.
 * The row is `unknown` because its shape is the installed schema's business, not ours.
 */
export interface VfsRevisionSource {
	one(query: string, ...bindings: unknown[]): unknown
}

const REVISION_QUERY = "SELECT v FROM vfs_meta WHERE k = 'rev'"

function revisionOf(row: unknown): number | undefined {
	if (typeof row !== 'object' || row === null || !('v' in row)) return undefined
	return typeof row.v === 'number' ? row.v : undefined
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
	}
}
