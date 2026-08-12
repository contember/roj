import { describe, expect, test } from 'bun:test'
import { createNativeDiffSummary } from './diff.js'
import type { NativeDiffEntry } from './diff.js'
import { WORKDIR, buildIndex, workspace } from './fake-workspace.js'
import type { FakeFile, IndexInput } from './fake-workspace.js'

/** A worktree with `.git/index` written for the tracked files, and their blobs readable. */
function scenario(options: {
	tracked: IndexInput[]
	worktree: FakeFile[]
	extra?: FakeFile[]
	indexBytes?: Uint8Array
}) {
	const index = options.indexBytes ?? buildIndex(options.tracked)
	const files: FakeFile[] = [
		...options.worktree,
		...options.extra ?? [],
		{ path: `${WORKDIR}/.git/index`, content: index, mtimeMs: 1 },
	]
	// The index records these contents, so catFile must be able to serve them.
	const fake = workspace(files, { blobs: options.tracked.map((entry) => entry.content) })
	return createNativeDiffSummary(fake)
}

function sorted(entries: NativeDiffEntry[] | undefined): NativeDiffEntry[] | undefined {
	return entries?.slice().sort((a, b) => a.path.localeCompare(b.path))
}

const TRACKED: IndexInput[] = [
	{ path: 'a.txt', content: 'one\ntwo\nthree\n', mtimeMs: 1_700_000_000_000 },
	{ path: 'src/b.txt', content: 'beta\n', mtimeMs: 1_700_000_001_000 },
]

const CLEAN_TREE: FakeFile[] = [
	{ path: `${WORKDIR}/a.txt`, content: 'one\ntwo\nthree\n', mtimeMs: 1_700_000_000_000 },
	{ path: `${WORKDIR}/src/b.txt`, content: 'beta\n', mtimeMs: 1_700_000_001_000 },
]

describe('createNativeDiffSummary', () => {
	test('reports nothing when the tree matches the index', async () => {
		const diff = scenario({ tracked: TRACKED, worktree: CLEAN_TREE })
		expect(await diff(WORKDIR)).toEqual([])
	})

	test('counts a changed line as one insertion and one deletion', async () => {
		const diff = scenario({
			tracked: TRACKED,
			worktree: [
				{ path: `${WORKDIR}/a.txt`, content: 'one\nCHANGED\nthree\n', mtimeMs: 1_700_000_009_000 },
				CLEAN_TREE[1],
			],
		})
		expect(await diff(WORKDIR)).toEqual([
			{ path: 'a.txt', status: 'M', insertions: 1, deletions: 1 },
		])
	})

	test('counts appended lines as insertions only', async () => {
		const diff = scenario({
			tracked: TRACKED,
			worktree: [
				{ path: `${WORKDIR}/a.txt`, content: 'one\ntwo\nthree\nfour\nfive\n', mtimeMs: 1_700_000_009_000 },
				CLEAN_TREE[1],
			],
		})
		expect(await diff(WORKDIR)).toEqual([
			{ path: 'a.txt', status: 'M', insertions: 2, deletions: 0 },
		])
	})

	test('reports an untracked file as added, with every line an insertion', async () => {
		const diff = scenario({
			tracked: TRACKED,
			worktree: CLEAN_TREE,
			extra: [{ path: `${WORKDIR}/new.txt`, content: 'x\ny\n', mtimeMs: 1_700_000_009_000 }],
		})
		expect(await diff(WORKDIR)).toEqual([
			{ path: 'new.txt', status: 'A', insertions: 2, deletions: 0 },
		])
	})

	test('reports a missing tracked file as deleted, with every line a deletion', async () => {
		const diff = scenario({ tracked: TRACKED, worktree: [CLEAN_TREE[1]] })
		expect(await diff(WORKDIR)).toEqual([
			{ path: 'a.txt', status: 'D', insertions: 0, deletions: 3 },
		])
	})

	test('flags binary content instead of counting lines in it', async () => {
		const binary = new Uint8Array([0x89, 0x50, 0x00, 0x01])
		const diff = scenario({
			tracked: TRACKED,
			worktree: CLEAN_TREE,
			extra: [{ path: `${WORKDIR}/logo.png`, content: binary, mtimeMs: 1_700_000_009_000 }],
		})
		expect(await diff(WORKDIR)).toEqual([
			{ path: 'logo.png', status: 'A', insertions: 0, deletions: 0, binary: true },
		])
	})

	test('narrows to the paths asked for', async () => {
		const diff = scenario({
			tracked: TRACKED,
			worktree: [
				{ path: `${WORKDIR}/a.txt`, content: 'one\nCHANGED\nthree\n', mtimeMs: 1_700_000_009_000 },
				{ path: `${WORKDIR}/src/b.txt`, content: 'BETA\n', mtimeMs: 1_700_000_009_000 },
			],
		})
		expect(await diff(WORKDIR, ['src/b.txt'])).toEqual([
			{ path: 'src/b.txt', status: 'M', insertions: 1, deletions: 1 },
		])
	})

	test('returns every changed path in path order', async () => {
		const diff = scenario({
			tracked: TRACKED,
			worktree: [
				{ path: `${WORKDIR}/a.txt`, content: 'one\nCHANGED\nthree\n', mtimeMs: 1_700_000_009_000 },
				{ path: `${WORKDIR}/src/b.txt`, content: 'BETA\n', mtimeMs: 1_700_000_009_000 },
			],
		})
		expect(sorted(await diff(WORKDIR))?.map((entry) => entry.path)).toEqual(['a.txt', 'src/b.txt'])
	})

	test('declines rather than guessing when the index cannot be read', async () => {
		const diff = scenario({ tracked: TRACKED, worktree: CLEAN_TREE, indexBytes: new Uint8Array([1, 2, 3]) })
		expect(await diff(WORKDIR)).toBeUndefined()
	})

	test('declines when the directory is not a repository', async () => {
		const diff = scenario({ tracked: TRACKED, worktree: CLEAN_TREE })
		expect(await diff('/elsewhere')).toBeUndefined()
	})
})
