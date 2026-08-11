/**
 * The workspace's own SQLite, as the calls this package makes of it.
 *
 * `vfs_*` is `@cloudflare/computer`'s private schema, not an API — it carries
 * migrations v1→v5 already — so readers over it are written to degrade to
 * `undefined` rather than throw, and callers fall back to the public binding.
 * Rows come back as `unknown` because their shape is the installed schema's
 * business; these helpers are how a column is read without asserting one.
 */

export interface VfsSource {
	one(query: string, ...bindings: unknown[]): unknown
	all(query: string, ...bindings: unknown[]): unknown[]
}

export function numberField(row: unknown, key: string): number | undefined {
	if (typeof row !== 'object' || row === null || !(key in row)) return undefined
	const value = Reflect.get(row, key)
	return typeof value === 'number' ? value : undefined
}

export function stringField(row: unknown, key: string): string | undefined {
	if (typeof row !== 'object' || row === null || !(key in row)) return undefined
	const value = Reflect.get(row, key)
	return typeof value === 'string' ? value : undefined
}

/** True when the column is present and holds anything other than NULL. */
export function hasValue(row: unknown, key: string): boolean {
	if (typeof row !== 'object' || row === null || !(key in row)) return false
	const value = Reflect.get(row, key)
	return value !== null && value !== undefined
}
