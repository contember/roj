/**
 * Containment check shared by every route that serves a file off disk.
 *
 * A lexical check (`resolve()` then a prefix compare) only sees the path string.
 * The agent can write inside the session directory — the shell plugin binds it
 * into the sandbox read-write — so it can leave a symlink there pointing at any
 * file the process can read. Only realpath-ing both ends catches that, and it
 * has to happen after the path is resolved, not before.
 */

import { isAbsolute, relative, sep } from 'node:path'
import { type AppContext, getServices } from './context.js'

export type CanonicalPathResult =
	| { status: 'ok'; path: string }
	| { status: 'not_found' }
	| { status: 'forbidden' }

export async function resolveCanonicalPath(
	c: AppContext,
	rootPath: string,
	targetPath: string,
): Promise<CanonicalPathResult> {
	const { platform } = getServices(c)
	let canonicalRoot: string
	let canonicalTarget: string
	try {
		canonicalRoot = await platform.fs.realpath(rootPath)
		canonicalTarget = await platform.fs.realpath(targetPath)
	} catch {
		return { status: 'not_found' }
	}

	const relativeTarget = relative(canonicalRoot, canonicalTarget)
	const isContained = relativeTarget === '' || (
		!isAbsolute(relativeTarget)
		&& relativeTarget !== '..'
		&& !relativeTarget.startsWith(`..${sep}`)
	)

	return isContained
		? { status: 'ok', path: canonicalTarget }
		: { status: 'forbidden' }
}
