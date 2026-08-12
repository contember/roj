/**
 * Insertion and deletion counts for one file, the numbers behind `--numstat`.
 *
 * Only the totals are wanted, never the hunks, and that makes the whole thing
 * one number: Myers' algorithm walks to the edit distance `D`, and since
 * `insertions + deletions = D` while `insertions - deletions = new - old`, both
 * counts fall out of it. No edit script is ever built, so nothing here holds
 * more than the two line arrays and one diagonal vector.
 */

/**
 * Beyond this the file is treated as rewritten; see `countChangedLines`.
 *
 * The walk costs about `D²/2` steps, so the cap is what bounds one file's share
 * of a diff: 2,000 is a few milliseconds, 20,000 is three seconds. An edit
 * script this long is a rewrite by any reading, and the fallback says so.
 */
const MAX_EDITS = 2_000

/** A NUL in the first sample of a file is git's own binary test. */
const BINARY_SNIFF_BYTES = 8_000

export interface LineCounts {
	insertions: number
	deletions: number
	/** Nothing was counted: git reports `-` for these rather than a number. */
	binary: boolean
}

export function isBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

const decoder = new TextDecoder()

/**
 * Lines as git counts them: a trailing newline closes the last line rather than
 * opening an empty one, and an empty file has no lines at all.
 */
export function splitLines(bytes: Uint8Array): string[] {
	if (bytes.length === 0) return []
	const text = decoder.decode(bytes)
	const lines = text.split('\n')
	if (lines[lines.length - 1] === '') lines.pop()
	return lines
}

/**
 * Edit distance between two line arrays, or `undefined` past `MAX_EDITS`.
 *
 * Greedy Myers over the diagonals. `v` holds the furthest `x` reached on each
 * diagonal `k = x - y`, offset so a negative `k` indexes from the middle.
 */
function editDistance(a: readonly string[], b: readonly string[]): number | undefined {
	const n = a.length
	const m = b.length
	const max = Math.min(n + m, MAX_EDITS)
	const offset = max
	const v = new Int32Array(2 * max + 1)

	for (let d = 0; d <= max; d++) {
		for (let k = -d; k <= d; k += 2) {
			// Step down from the diagonal above (an insertion) when it reaches
			// further, otherwise right from the one below (a deletion).
			const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
			let x = down ? v[offset + k + 1] : v[offset + k - 1] + 1
			let y = x - k
			while (x < n && y < m && a[x] === b[y]) {
				x++
				y++
			}
			v[offset + k] = x
			if (x >= n && y >= m) return d
		}
	}
	return undefined
}

/**
 * How many lines were added and removed between two versions of a file.
 *
 * Identical head and tail lines are dropped first — they cannot be part of any
 * edit, and trimming them keeps the search proportional to the change rather
 * than to the file. A diff too large to walk (`MAX_EDITS`) is reported as a
 * whole-file rewrite, which is what a file sharing no lines with its previous
 * version genuinely is and an over-count for anything else.
 */
export function countChangedLines(before: Uint8Array, after: Uint8Array): LineCounts {
	if (isBinary(before) || isBinary(after)) return { insertions: 0, deletions: 0, binary: true }

	const oldLines = splitLines(before)
	const newLines = splitLines(after)

	let head = 0
	while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++

	let tail = 0
	while (
		tail < oldLines.length - head &&
		tail < newLines.length - head &&
		oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
	) {
		tail++
	}

	const a = oldLines.slice(head, oldLines.length - tail)
	const b = newLines.slice(head, newLines.length - tail)
	if (a.length === 0 && b.length === 0) return { insertions: 0, deletions: 0, binary: false }

	const distance = editDistance(a, b)
	if (distance === undefined) return { insertions: b.length, deletions: a.length, binary: false }

	// insertions + deletions = distance, insertions - deletions = b - a.
	const insertions = (distance + b.length - a.length) / 2
	return { insertions, deletions: distance - insertions, binary: false }
}
