/**
 * Containment check for paths that are about to be handed to the filesystem.
 *
 * A lexical check (`resolve()` then a prefix compare) only sees the path string,
 * so a link inside a root can still point anywhere the process can reach. Both
 * ends are canonicalized here instead. Links are not banned — one whose target
 * lands back inside a root stays usable.
 */

import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { FileSystem } from '~/platform/fs.js'

/**
 * Where a path's real target sits.
 *
 * `unresolvable` is a path that exists but cannot be canonicalized — a link with
 * no target, a link loop. Only an operation that would create through it has to
 * refuse; the ones that merely follow it fail on their own.
 */
export type Containment = 'inside' | 'outside' | 'unresolvable'

export async function containmentOf(
	fs: FileSystem,
	roots: readonly string[],
	path: string,
): Promise<Containment> {
	// A path that is one of its own roots is inside it whatever it resolves to.
	if (roots.includes(path)) return 'inside'

	const target = await canonicalize(fs, path)
	if (target === null) return 'unresolvable'

	for (const root of roots) {
		const canonicalRoot = await canonicalize(fs, root)
		if (canonicalRoot !== null && isUnder(canonicalRoot, target)) return 'inside'
	}
	return 'outside'
}

function isUnder(root: string, target: string): boolean {
	const rel = relative(root, target)
	return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/**
 * Canonical form of `path`, resolving through its deepest existing ancestor so
 * a not-yet-created file is judged by the directory it would land in.
 * Null when a component exists but cannot be resolved.
 */
async function canonicalize(fs: FileSystem, path: string): Promise<string | null> {
	const missing: string[] = []
	let current = path
	for (;;) {
		try {
			const real = await fs.realpath(current)
			return missing.length > 0 ? join(real, ...missing) : real
		} catch {
			if (await entryExists(fs, current)) return null
			const parent = dirname(current)
			if (parent === current) return null
			missing.unshift(basename(current))
			current = parent
		}
	}
}

/** Anything `lstat` rejects counts as absent, an unreadable parent included — the caller's own operation then reports it. */
async function entryExists(fs: FileSystem, path: string): Promise<boolean> {
	try {
		await fs.lstat(path)
		return true
	} catch {
		return false
	}
}
