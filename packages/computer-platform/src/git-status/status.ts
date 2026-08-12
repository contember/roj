/**
 * `git status`, answered from SQLite and the git index instead of from a walk.
 *
 * What it replaces costs ~0.6 ms per filesystem node and touches every one of
 * them: on a cloned site of 7,657 files a `git status` with nothing to report
 * takes ~7.8 s, and an editor asks for one after every save. Measured against
 * the same repository this answers in ~50 ms, because the tree walk is a
 * recursive CTE (~35 ms) and only the paths whose stat moved are ever read.
 *
 * The comparison is the one git itself makes: the working tree against
 * `.git/index`. The index is what makes this possible without any state of our
 * own — it records, per path, the blob git has and the size and mtime the file
 * had when git last looked. A path whose size and mtime still match cannot have
 * been written since, so it is clean without reading a byte; everything else is
 * hashed and compared against the recorded blob. The comparison itself lives in
 * scan.ts, which `diffSummary` shares.
 *
 * Two things are deliberately left to the binding rather than approximated:
 *
 *   - The staged half of the XY pair. Knowing whether the index differs from
 *     HEAD means reading HEAD's tree, and that measured 36 s on the same
 *     repository — so `index` is always reported as clean here. A path staged
 *     with `git add` whose working copy matches what was staged is therefore not
 *     reported. In this host nothing stages without committing in the same
 *     breath, so that is a window rather than a state.
 *   - Anything the reader will not vouch for — a v3/v4 index, an unmerged path,
 *     a submodule, a mounted node, `core.autocrlf` — returns `undefined`, and
 *     the caller runs the git binding it would have run anyway.
 */

import type { GitStatusEntry } from '@roj-ai/sdk/platform'
import { createWorktreeScan } from './scan.js'
import type { WorktreeScanOptions } from './scan.js'

export type NativeGitStatus = (dir: string) => Promise<GitStatusEntry[] | undefined>

export type NativeGitStatusOptions = WorktreeScanOptions

/** `A` is git's `?` here: untracked, because nothing stages without committing. */
const WORKTREE_CODE = { A: '?', M: 'M', D: 'D' } as const

export function createNativeGitStatus(options: NativeGitStatusOptions): NativeGitStatus {
	const scan = createWorktreeScan(options)
	return async (dir) => {
		const entries = await scan(dir)
		return entries?.map((entry) => ({ path: entry.path, index: ' ', worktree: WORKTREE_CODE[entry.status] }))
	}
}
