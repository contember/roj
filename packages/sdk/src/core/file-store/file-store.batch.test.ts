/**
 * `SessionFileStore.list` against a platform that answers `walk` and one that
 * does not — same listing, different number of questions.
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countFsCalls, withBatchVerbs, withScopeReads } from '~/lib/utils/fs-batch-doubles.test.js'
import type { FileSystem } from '~/platform/fs.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { SessionFileStore } from './file-store.js'
import type { FileEntry } from './types.js'

async function withTree(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'roj-file-store-batch-'))
	try {
		await writeFile(join(root, 'top.txt'), 'top')
		await writeFile(join(root, '.hidden'), 'hidden')
		await mkdir(join(root, 'sub', 'deep'), { recursive: true })
		await writeFile(join(root, 'sub', 'mid.txt'), 'middle')
		await writeFile(join(root, 'sub', 'deep', 'leaf.txt'), 'leaf!')
		await symlink(join(root, 'top.txt'), join(root, 'link.txt'))
		await run(root)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

function storeOn(root: string, fs: FileSystem): SessionFileStore {
	return new SessionFileStore(root, undefined, false, fs, 'session')
}

async function listOn(root: string, fs: FileSystem, maxDepth: number): Promise<FileEntry[]> {
	const result = await storeOn(root, fs).list('', { maxDepth })
	if (!result.ok) throw new Error(result.error)
	return result.value
}

describe('SessionFileStore.list with and without walk', () => {
	test.each([1, 2, 3])('depth %i lists the same entries either way', async (maxDepth) => {
		await withTree(async (root) => {
			const loop = countFsCalls(createNodeFileSystem())
			const batch = countFsCalls(withBatchVerbs(createNodeFileSystem()))

			const viaLoop = await listOn(root, loop.fs, maxDepth)
			const viaBatch = await listOn(root, batch.fs, maxDepth)

			expect(viaBatch).toEqual(viaLoop)
			// Neither path is the other in disguise: one asked `walk`, one asked readdir.
			expect(batch.calls).toEqual({ walk: 1 })
			expect(loop.calls.walk).toBeUndefined()
			expect(loop.calls.readdir ?? 0).toBeGreaterThan(0)
		})
	})

	test('reports the depth, types and sizes the readdir walk reports', async () => {
		await withTree(async (root) => {
			const entries = await listOn(root, withBatchVerbs(createNodeFileSystem()), 3)
			expect([...entries].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
				{ name: '.hidden', type: 'file', size: 6 },
				{ name: 'link.txt', type: 'symlink', size: undefined },
				{ name: 'sub', type: 'directory', size: undefined },
				{ name: 'sub/deep', type: 'directory', size: undefined },
				{ name: 'sub/deep/leaf.txt', type: 'file', size: 5 },
				{ name: 'sub/mid.txt', type: 'file', size: 6 },
				{ name: 'top.txt', type: 'file', size: 3 },
			])
		})
	})

	test('the walk-less fallback runs inside scopeReads where the platform has one', async () => {
		await withTree(async (root) => {
			const scoped = countFsCalls(withScopeReads(createNodeFileSystem()))
			const plain = countFsCalls(createNodeFileSystem())

			expect(await listOn(root, scoped.fs, 2)).toEqual(await listOn(root, plain.fs, 2))
			expect(scoped.calls.scopeReads).toBe(1)
			expect(scoped.calls.readdir).toBe(plain.calls.readdir)
		})
	})

	test('a missing directory is an error on both paths', async () => {
		await withTree(async (root) => {
			for (const fs of [createNodeFileSystem(), withBatchVerbs(createNodeFileSystem())]) {
				expect(await storeOn(root, fs).list('nope')).toEqual({ ok: false, error: 'Directory not found: nope' })
			}
		})
	})
})
