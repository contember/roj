/**
 * `git diff --numstat` for the working tree, bounded by what changed.
 *
 * The binding's `diffSummary` asks isomorphic-git for a status matrix over the
 * whole tree and filters afterwards, so a one-file change costs the same ~8 s a
 * full one does. This asks scan.ts which paths moved — a recursive CTE plus the
 * index, ~50 ms — and then reads two blobs per changed path and nothing else.
 * Cost follows the size of the change, which is the property the binding lacks.
 *
 * The baseline is the index, so this is `git diff` with no arguments: the
 * working tree against what is staged. Same limits as status.ts, and the same
 * contract — `undefined` means "ask the binding", never "nothing changed".
 */

import type { GitClient as ComputerGitClient } from '@cloudflare/computer/git'
import type { FileSystem } from '@roj-ai/sdk/platform'
import { countChangedLines } from './line-diff.js'
import { createWorktreeScan } from './scan.js'
import type { ScanEntry, WorktreeScanOptions } from './scan.js'

/** Matches computer's `DiffSummaryEntry`, plus the flag that shape cannot carry. */
export interface NativeDiffEntry {
	path: string
	status: 'A' | 'M' | 'D'
	insertions: number
	deletions: number
	/**
	 * Lines were not counted, and the zeroes mean "not applicable" rather than
	 * "unchanged" — what git prints as `-` in `--numstat`. The binding counts
	 * lines in the bytes instead, so it reports a figure here where git does not.
	 */
	binary?: boolean
}

export type NativeDiffSummary = (dir: string, paths?: readonly string[]) => Promise<NativeDiffEntry[] | undefined>

export type NativeDiffSummaryOptions = WorktreeScanOptions

/** Blobs read at once. Enough to keep the reads busy, few enough to bound memory. */
const READ_CONCURRENCY = 16

const EMPTY = new Uint8Array(0)

export function createNativeDiffSummary(options: NativeDiffSummaryOptions): NativeDiffSummary {
	const { git, fs } = options
	const scan = createWorktreeScan(options)

	/** The staged blob, or empty when the object is not readable as one. */
	const readBlob = async (dir: string, oid: string | undefined): Promise<Uint8Array> => {
		if (oid === undefined) return EMPTY
		const object = await git.catFile({ dir, oid })
		return object.bytes
	}

	const readWorktree = async (dir: string, path: string): Promise<Uint8Array> => {
		try {
			return await fs.readFile(`${dir}/${path}`)
		} catch {
			return EMPTY
		}
	}

	const measure = async (dir: string, entry: ScanEntry): Promise<NativeDiffEntry> => {
		// A delete has no working copy and an add has no baseline; both sides are
		// read the same way and the missing one is simply empty.
		const [before, after] = await Promise.all([
			entry.status === 'A' ? EMPTY : readBlob(dir, entry.oid),
			entry.status === 'D' ? EMPTY : readWorktree(dir, entry.path),
		])
		const counts = countChangedLines(before, after)
		return {
			path: entry.path,
			status: entry.status,
			insertions: counts.insertions,
			deletions: counts.deletions,
			...(counts.binary ? { binary: true } : {}),
		}
	}

	return async (dir, paths) => {
		try {
			const entries = await scan(dir)
			if (entries === undefined) return undefined

			const filter = paths === undefined ? undefined : new Set(paths)
			const wanted = filter === undefined ? entries : entries.filter((entry) => filter.has(entry.path))

			const summary: NativeDiffEntry[] = []
			for (let start = 0; start < wanted.length; start += READ_CONCURRENCY) {
				const batch = wanted.slice(start, start + READ_CONCURRENCY)
				summary.push(...await Promise.all(batch.map((entry) => measure(dir, entry))))
			}
			return summary.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
		} catch {
			return undefined
		}
	}
}
