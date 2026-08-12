/**
 * Every expectation here was taken from real `git diff --numstat`, not derived
 * from the implementation — the point of the counts is that they match what git
 * would have said, so anything else is a wrong answer however defensible.
 */

import { describe, expect, it } from 'bun:test'
import { countChangedLines, isBinary, splitLines } from './line-diff.js'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

const counts = (before: string, after: string) => {
	const result = countChangedLines(bytes(before), bytes(after))
	return [result.insertions, result.deletions]
}

describe('countChangedLines', () => {
	// Cases and expectations from `git diff --numstat`; see numstat-cases.sh.
	it('counts a replaced middle the way git does', () => {
		expect(counts('a\nb\nc\nd\ne\n', 'a\nb\nX\nY\nd\ne\n')).toEqual([2, 1])
	})

	it('counts an append as insertions only', () => {
		expect(counts('a\nb\n', 'a\nb\nc\nd\n')).toEqual([2, 0])
	})

	it('counts a prepend as insertions only', () => {
		expect(counts('a\nb\n', 'x\ny\na\nb\n')).toEqual([2, 0])
	})

	it('counts a deletion as deletions only', () => {
		expect(counts('a\nb\nc\nd\n', 'a\nd\n')).toEqual([0, 2])
	})

	it('reports nothing for identical content', () => {
		expect(counts('a\nb\n', 'a\nb\n')).toEqual([0, 0])
	})

	it('counts a whole rewrite on both sides', () => {
		expect(counts('a\nb\nc\n', 'x\ny\nz\n')).toEqual([3, 3])
	})

	it('ignores a missing trailing newline', () => {
		expect(counts('a\nb\nc', 'a\nb\nd')).toEqual([1, 1])
	})

	it('counts a file that did not exist as all insertions', () => {
		expect(counts('', 'a\nb\n')).toEqual([2, 0])
	})

	it('counts a file that was emptied as all deletions', () => {
		expect(counts('a\nb\n', '')).toEqual([0, 2])
	})

	it('picks one line out of repeats rather than rewriting them', () => {
		expect(counts('a\na\na\n', 'a\na\na\na\n')).toEqual([1, 0])
	})

	it('counts a moved block as a rewrite, having no rename detection', () => {
		expect(counts('a\nb\nc\nd\n', 'c\nd\na\nb\n')).toEqual([2, 2])
	})

	it('counts a removed blank line', () => {
		expect(counts('a\n\n\nb\n', 'a\n\nb\n')).toEqual([0, 1])
	})

	it('reports binary content as counted by neither side', () => {
		const result = countChangedLines(new Uint8Array([1, 0, 2]), bytes('a\n'))
		expect(result).toEqual({ insertions: 0, deletions: 0, binary: true })
	})

	it('stays exact on a change buried in a large file', () => {
		const before = `${Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')}\n`
		const after = before.replace('line 2500\n', 'changed\ninserted\n')
		expect(counts(before, after)).toEqual([2, 1])
	})

	it('falls back to a whole-file rewrite when the edit script is too large', () => {
		// Nothing in common and far past MAX_EDITS, so the walk is abandoned.
		const before = `${Array.from({ length: 30000 }, (_, i) => `old ${i}`).join('\n')}\n`
		const after = `${Array.from({ length: 30000 }, (_, i) => `new ${i}`).join('\n')}\n`
		expect(counts(before, after)).toEqual([30000, 30000])
	})
})

describe('splitLines', () => {
	it('treats a trailing newline as closing the last line', () => {
		expect(splitLines(bytes('a\nb\n'))).toEqual(['a', 'b'])
	})

	it('keeps a last line that has no newline', () => {
		expect(splitLines(bytes('a\nb'))).toEqual(['a', 'b'])
	})

	it('finds no lines in an empty file', () => {
		expect(splitLines(bytes(''))).toEqual([])
	})

	it('keeps interior blank lines', () => {
		expect(splitLines(bytes('a\n\nb\n'))).toEqual(['a', '', 'b'])
	})
})

describe('isBinary', () => {
	it('calls content with a NUL binary', () => {
		expect(isBinary(new Uint8Array([65, 0, 66]))).toBe(true)
	})

	it('calls text without a NUL text', () => {
		expect(isBinary(bytes('plain text\n'))).toBe(false)
	})

	it('only sniffs the head, so a late NUL does not count', () => {
		const late = new Uint8Array(9000)
		late.fill(65)
		late[8500] = 0
		expect(isBinary(late)).toBe(false)
	})
})
