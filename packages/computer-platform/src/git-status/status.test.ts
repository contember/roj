import { describe, expect, test } from 'bun:test'
import type { GitStatusEntry } from '@roj-ai/sdk/platform'
import { WORKDIR, buildIndex, workspace } from './fake-workspace.js'
import type { FakeFile, IndexInput } from './fake-workspace.js'
import { createNativeGitStatus } from './status.js'


/** A worktree with `.git/index` written for exactly the files listed as tracked. */
function scenario(options: {
	tracked: IndexInput[]
	worktree: FakeFile[]
	extra?: FakeFile[]
	autocrlf?: string
	indexBytes?: Uint8Array
}) {
	const index = options.indexBytes ?? buildIndex(options.tracked)
	const files: FakeFile[] = [
		...options.worktree,
		...options.extra ?? [],
		{ path: `${WORKDIR}/.git/index`, content: index, mtimeMs: 1 },
	]
	const fake = workspace(files, options.autocrlf === undefined ? {} : { autocrlf: options.autocrlf })
	return createNativeGitStatus(fake)
}

function sorted(entries: GitStatusEntry[] | undefined): GitStatusEntry[] | undefined {
	return entries?.slice().sort((a, b) => a.path.localeCompare(b.path))
}

const CLEAN: IndexInput[] = [
	{ path: 'a.txt', content: 'alpha\n', mtimeMs: 1_700_000_000_000 },
	{ path: 'src/b.txt', content: 'beta\n', mtimeMs: 1_700_000_001_000 },
]

const CLEAN_TREE: FakeFile[] = [
	{ path: `${WORKDIR}/a.txt`, content: 'alpha\n', mtimeMs: 1_700_000_000_000 },
	{ path: `${WORKDIR}/src/b.txt`, content: 'beta\n', mtimeMs: 1_700_000_001_000 },
]

describe('createNativeGitStatus', () => {
	test('reports nothing for a tree that matches its index', async () => {
		const status = scenario({ tracked: CLEAN, worktree: CLEAN_TREE })
		expect(await status(WORKDIR)).toEqual([])
	})

	test('reports a file whose content changed', async () => {
		const status = scenario({
			tracked: CLEAN,
			worktree: [
				{ path: `${WORKDIR}/a.txt`, content: 'alpha edited\n', mtimeMs: 1_700_000_500_000 },
				...CLEAN_TREE.slice(1),
			],
		})
		expect(await status(WORKDIR)).toEqual([{ path: 'a.txt', index: ' ', worktree: 'M' }])
	})

	// The filesystem revision moves on any write, so a rewrite with the same bytes
	// looks like an edit until something hashes it. Over-reporting here would put a
	// change in the publish bar that a commit would then find nothing to commit.
	test('reports nothing for a file rewritten with the bytes it already had', async () => {
		const status = scenario({
			tracked: CLEAN,
			worktree: [
				{ path: `${WORKDIR}/a.txt`, content: 'alpha\n', mtimeMs: 1_700_009_999_000 },
				...CLEAN_TREE.slice(1),
			],
		})
		expect(await status(WORKDIR)).toEqual([])
	})

	test('reports a tracked file that is gone', async () => {
		const status = scenario({ tracked: CLEAN, worktree: [CLEAN_TREE[0] ?? CLEAN_TREE[0]].filter((file) => file !== undefined) })
		expect(await status(WORKDIR)).toEqual([{ path: 'src/b.txt', index: ' ', worktree: 'D' }])
	})

	test('reports an untracked file', async () => {
		const status = scenario({
			tracked: CLEAN,
			worktree: CLEAN_TREE,
			extra: [{ path: `${WORKDIR}/new.txt`, content: 'new\n', mtimeMs: 1_700_000_900_000 }],
		})
		expect(await status(WORKDIR)).toEqual([{ path: 'new.txt', index: ' ', worktree: '?' }])
	})

	test('keeps an ignored file out of the count', async () => {
		const status = scenario({
			tracked: CLEAN,
			worktree: CLEAN_TREE,
			extra: [
				{ path: `${WORKDIR}/.gitignore`, content: 'dist/\n', mtimeMs: 1_700_000_002_000 },
				{ path: `${WORKDIR}/dist/bundle.js`, content: 'x\n', mtimeMs: 1_700_000_900_000 },
			],
		})
		// `.gitignore` itself is untracked here, and git reports that one.
		expect(sorted(await status(WORKDIR))).toEqual([{ path: '.gitignore', index: ' ', worktree: '?' }])
	})

	test('never looks inside .git', async () => {
		const status = scenario({
			tracked: CLEAN,
			worktree: CLEAN_TREE,
			extra: [{ path: `${WORKDIR}/.git/HEAD`, content: 'ref: refs/heads/main\n', mtimeMs: 1 }],
		})
		expect(await status(WORKDIR)).toEqual([])
	})

	test('reports a symlink by its target, not by a file read', async () => {
		const tracked: IndexInput[] = [{ path: 'link', content: 'src/b.txt', mtimeMs: 1_700_000_003_000, mode: 0o120000 }]
		const clean = scenario({
			tracked,
			worktree: [{ path: `${WORKDIR}/link`, target: 'src/b.txt', mtimeMs: 1_700_000_003_000 }],
		})
		expect(await clean(WORKDIR)).toEqual([])

		const moved = scenario({
			tracked,
			worktree: [{ path: `${WORKDIR}/link`, target: 'src/other.txt', mtimeMs: 1_700_000_004_000 }],
		})
		expect(await moved(WORKDIR)).toEqual([{ path: 'link', index: ' ', worktree: 'M' }])
	})

	test('reports a path that became a file where a symlink was', async () => {
		const status = scenario({
			tracked: [{ path: 'link', content: 'src/b.txt', mtimeMs: 1_700_000_003_000, mode: 0o120000 }],
			worktree: [{ path: `${WORKDIR}/link`, content: 'src/b.txt', mtimeMs: 1_700_000_003_000 }],
		})
		expect(await status(WORKDIR)).toEqual([{ path: 'link', index: ' ', worktree: 'M' }])
	})

	test('declines when the index is not one it reads', async () => {
		const status = scenario({ tracked: CLEAN, worktree: CLEAN_TREE, indexBytes: new Uint8Array(64) })
		expect(await status(WORKDIR)).toBeUndefined()
	})

	test('declines when there is no repository at the path', async () => {
		const fake = workspace([{ path: `${WORKDIR}/a.txt`, content: 'alpha\n', mtimeMs: 1 }])
		expect(await createNativeGitStatus(fake)(WORKDIR)).toBeUndefined()
	})

	test('declines when line endings are filtered, since the bytes on disk are not what git hashed', async () => {
		const status = scenario({ tracked: CLEAN, worktree: CLEAN_TREE, autocrlf: 'true' })
		expect(await status(WORKDIR)).toBeUndefined()
	})

	test('answers normally when line-ending filtering is explicitly off', async () => {
		const status = scenario({ tracked: CLEAN, worktree: CLEAN_TREE, autocrlf: 'false' })
		expect(await status(WORKDIR)).toEqual([])
	})

	test('declines when a mounted node is in the tree, whose recorded size is a stub', async () => {
		const status = scenario({
			tracked: CLEAN,
			worktree: CLEAN_TREE,
			extra: [{ path: `${WORKDIR}/assets/big.bin`, content: 'x', mtimeMs: 1, mount: true }],
		})
		expect(await status(WORKDIR)).toBeUndefined()
	})

	test('declines rather than throwing when the schema is gone', async () => {
		const broken: VfsSource = {
			one() {
				throw new Error('no such table: vfs_dirents')
			},
			all() {
				throw new Error('no such table: vfs_dirents')
			},
		}
		const fake = workspace(CLEAN_TREE)
		expect(await createNativeGitStatus({ ...fake, db: broken })(WORKDIR)).toBeUndefined()
	})
})
