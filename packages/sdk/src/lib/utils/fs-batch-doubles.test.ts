/**
 * Test doubles for the optional `FileSystem` batch verbs.
 *
 * The verbs are optional, so every call site that uses one keeps the loop it
 * would otherwise have run. That makes a second implementation nobody compares,
 * unless the same call site is driven against a platform that answers the verbs
 * and one that does not. These wrap the node test platform so it can be both.
 *
 * `countFsCalls` sits OUTSIDE the verb wrappers on purpose: reads a verb makes
 * for itself go straight to node, so a counted `readdir` means the call site
 * asked for one.
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileSystem, ReadFilesEntry, WalkEntry, WalkOptions } from '~/platform/fs.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'

/** How many times each verb was called, keyed by verb name. */
export type FsCallCounts = Record<string, number | undefined>

/** Counts every verb the code under test reaches for on `base`. */
export function countFsCalls(base: FileSystem): { fs: FileSystem; calls: FsCallCounts } {
	const calls: FsCallCounts = {}
	const fs = new Proxy(base, {
		get(target, prop) {
			const value = Reflect.get(target, prop)
			if (typeof value !== 'function' || typeof prop !== 'string') return value
			return (...args: unknown[]) => {
				calls[prop] = (calls[prop] ?? 0) + 1
				return Reflect.apply(value, target, args)
			}
		},
	})
	return { fs, calls }
}

/** `walk`, answered over node:fs. */
export function withWalk(base: FileSystem): FileSystem {
	return { ...base, walk: (dir, options) => nodeWalk(base, dir, options) }
}

/** `readFiles`, answered over node:fs. */
export function withReadFiles(base: FileSystem): FileSystem {
	return { ...base, readFiles: (paths) => nodeReadFiles(base, paths) }
}

/** `scopeReads`, which for node:fs can only run the block. */
export function withScopeReads(base: FileSystem): FileSystem {
	return { ...base, scopeReads: (fn) => fn() }
}

/** Every batch verb at once — the platform a call site should be compared against. */
export function withBatchVerbs(base: FileSystem): FileSystem {
	return withScopeReads(withReadFiles(withWalk(base)))
}

async function nodeWalk(base: FileSystem, dir: string, options?: WalkOptions): Promise<WalkEntry[]> {
	const excluded = new Set(options?.exclude ?? [])
	const out: WalkEntry[] = []

	const descend = async (current: string, depthLeft: number): Promise<void> => {
		for (const dirent of await base.readdir(current, { withFileTypes: true })) {
			if (options?.limit !== undefined && out.length >= options.limit) return
			if (excluded.has(dirent.name)) continue
			if (options?.excludeHidden && dirent.name.startsWith('.')) continue

			const path = join(current, dirent.name)
			const type = dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : dirent.isFile() ? 'file' : undefined
			if (type === undefined) continue

			let size = 0
			let mtime = 0
			try {
				const stats = await base.stat(path)
				size = type === 'directory' ? 0 : stats.size
				mtime = stats.mtimeMs
			} catch {
				continue
			}

			out.push({ path, type, size, mtime })
			if (type === 'directory' && depthLeft > 1) await descend(path, depthLeft - 1)
		}
	}

	await descend(dir, options?.depth ?? Number.POSITIVE_INFINITY)
	return out
}

async function nodeReadFiles(base: FileSystem, paths: readonly string[]): Promise<ReadFilesEntry[]> {
	return Promise.all(paths.map(async (path): Promise<ReadFilesEntry> => {
		try {
			return { path, content: await base.readFile(path) }
		} catch (error) {
			return { path, error: errorCode(error) }
		}
	}))
}

function errorCode(error: unknown): string {
	if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
	return String(error)
}

describe('batch-verb doubles', () => {
	test('walk reports the tree a readdir walk would, and the counter sees which ran', async () => {
		const root = await mkdtemp(join(tmpdir(), 'roj-walk-double-'))
		try {
			await mkdir(join(root, 'nested'))
			await writeFile(join(root, 'nested', 'leaf.txt'), 'leaf')
			await writeFile(join(root, 'top.txt'), 'top')
			await symlink(join(root, 'top.txt'), join(root, 'link.txt'))

			const { fs, calls } = countFsCalls(withBatchVerbs(createNodeFileSystem()))
			const walked = await fs.walk?.(root)

			expect(walked?.map((entry) => [entry.path.slice(root.length + 1), entry.type, entry.size]).sort()).toEqual([
				['link.txt', 'symlink', 3],
				['nested', 'directory', 0],
				['nested/leaf.txt', 'file', 4],
				['top.txt', 'file', 3],
			])
			// The double reads for itself, below the counter, so nothing is charged to the caller.
			expect(calls).toEqual({ walk: 1 })
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
