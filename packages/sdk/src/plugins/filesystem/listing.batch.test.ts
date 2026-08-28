/**
 * `listDirectory` and `listDirectoryRecursive` against a platform that answers
 * `walk` and one that does not — same listing, different number of questions.
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countFsCalls, withBatchVerbs, withScopeReads } from '~/lib/utils/fs-batch-doubles.test.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { listDirectory, listDirectoryRecursive, ListingError } from './listing.js'

async function withTree(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'roj-listing-batch-'))
	try {
		await writeFile(join(root, 'readme.md'), '# hi')
		await writeFile(join(root, '.hidden'), 'hidden')
		await mkdir(join(root, 'src', 'nested'), { recursive: true })
		await writeFile(join(root, 'src', 'app.ts'), 'export {}')
		await writeFile(join(root, 'src', '.env'), 'SECRET=1')
		await writeFile(join(root, 'src', 'nested', 'util.ts'), 'export const a = 1')
		await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
		await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}')
		await mkdir(join(root, 'dist'))
		await writeFile(join(root, 'dist', 'bundle.js'), 'bundled')
		await symlink(join(root, 'readme.md'), join(root, 'link.md'))
		await run(root)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

describe('listDirectory with and without walk', () => {
	test.each(['', 'src'])('level %p lists the same entries either way', async (subPath) => {
		await withTree(async (root) => {
			const loop = countFsCalls(createNodeFileSystem())
			const batch = countFsCalls(withBatchVerbs(createNodeFileSystem()))

			const viaLoop = await listDirectory(loop.fs, root, subPath)
			const viaBatch = await listDirectory(batch.fs, root, subPath)

			expect(viaBatch).toEqual(viaLoop)
			expect(batch.calls).toEqual({ walk: 1 })
			expect(loop.calls.walk).toBeUndefined()
			expect(loop.calls.readdir).toBe(1)
		})
	})

	test('reports the names, types, sizes and mime types the readdir level reports', async () => {
		await withTree(async (root) => {
			expect(await listDirectory(withBatchVerbs(createNodeFileSystem()), root, '')).toEqual([
				{ name: 'dist', type: 'directory', size: 0 },
				{ name: 'node_modules', type: 'directory', size: 0 },
				{ name: 'src', type: 'directory', size: 0 },
				{ name: 'link.md', type: 'file', size: 4, mimeType: 'text/markdown' },
				{ name: 'readme.md', type: 'file', size: 4, mimeType: 'text/markdown' },
			])
		})
	})

	test('the walk-less fallback runs inside scopeReads where the platform has one', async () => {
		await withTree(async (root) => {
			const scoped = countFsCalls(withScopeReads(createNodeFileSystem()))
			const plain = countFsCalls(createNodeFileSystem())

			expect(await listDirectory(scoped.fs, root, '')).toEqual(await listDirectory(plain.fs, root, ''))
			expect(scoped.calls.scopeReads).toBe(1)
			expect(scoped.calls.stat).toBe(plain.calls.stat)
		})
	})

	test('a missing directory raises the same ListingError on both paths', async () => {
		await withTree(async (root) => {
			for (const fs of [createNodeFileSystem(), withBatchVerbs(createNodeFileSystem())]) {
				await expect(listDirectory(fs, root, 'nope')).rejects.toThrow(
					new ListingError('not_found', 'Directory not found'),
				)
			}
		})
	})
})

describe('listDirectoryRecursive with and without walk', () => {
	test('lists the same tree either way, with the same skips', async () => {
		await withTree(async (root) => {
			const loop = countFsCalls(createNodeFileSystem())
			const batch = countFsCalls(withBatchVerbs(createNodeFileSystem()))

			const viaLoop = await listDirectoryRecursive(loop.fs, root)
			const viaBatch = await listDirectoryRecursive(batch.fs, root)

			expect(viaBatch).toEqual(viaLoop)
			expect(batch.calls).toEqual({ walk: 1 })
			expect(loop.calls.walk).toBeUndefined()
			expect(loop.calls.readdir).toBe(3)
		})
	})

	test('skips hidden names and the ignored directories at every level', async () => {
		await withTree(async (root) => {
			const entries = await listDirectoryRecursive(withBatchVerbs(createNodeFileSystem()), root)
			expect(entries.map((entry) => entry.path).sort()).toEqual([
				'link.md',
				'readme.md',
				'src',
				'src/app.ts',
				'src/nested',
				'src/nested/util.ts',
			])
			expect(entries.find((entry) => entry.path === 'link.md')).toEqual({
				name: 'link.md',
				path: 'link.md',
				type: 'file',
				size: 4,
				mimeType: 'text/markdown',
			})
		})
	})

	test('the walk-less fallback runs inside scopeReads where the platform has one', async () => {
		await withTree(async (root) => {
			const scoped = countFsCalls(withScopeReads(createNodeFileSystem()))
			const plain = countFsCalls(createNodeFileSystem())

			expect(await listDirectoryRecursive(scoped.fs, root)).toEqual(await listDirectoryRecursive(plain.fs, root))
			expect(scoped.calls.scopeReads).toBe(1)
			expect(scoped.calls.readdir).toBe(plain.calls.readdir)
		})
	})

	test('an unreadable root is an empty listing on both paths', async () => {
		await withTree(async (root) => {
			for (const fs of [createNodeFileSystem(), withBatchVerbs(createNodeFileSystem())]) {
				expect(await listDirectoryRecursive(fs, join(root, 'nope'))).toEqual([])
			}
		})
	})
})
