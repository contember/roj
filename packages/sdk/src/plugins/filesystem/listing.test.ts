import { describe, expect, test } from 'bun:test'
import type { Dirent, FileSystem, Stats, WalkEntry, WalkOptions } from '~/platform/fs.js'
import { listDirectoryRecursive } from './listing.js'

const TREE: Record<string, string[]> = { '/w': ['a.txt', 'sub'], '/w/sub': ['b.txt'] }
const SIZES: Record<string, number> = { '/w/a.txt': 3, '/w/sub/b.txt': 7 }

function dirent(parentPath: string, name: string): Dirent {
	const isDir = TREE[`${parentPath}/${name}`] !== undefined
	return {
		name,
		parentPath,
		isDirectory: () => isDir,
		isFile: () => !isDir,
		isSymbolicLink: () => false,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isFIFO: () => false,
		isSocket: () => false,
	}
}

/** Just enough filesystem for a walk over TREE. `onRead` sees every listing. */
function fakeFs(onRead?: (path: string) => void): FileSystem {
	const readdir = (path: string, options?: { withFileTypes: true }) => {
		onRead?.(path)
		const names = TREE[path] ?? []
		return Promise.resolve(
			options?.withFileTypes === true ? names.map((name) => dirent(path, name)) : names,
		)
	}
	return {
		readdir: readdir as FileSystem['readdir'],
		stat: (path: string) => Promise.resolve({ size: SIZES[path] ?? 0 } as Stats),
	} as FileSystem
}

describe('listDirectoryRecursive', () => {
	test('walks the tree with sizes', async () => {
		expect(await listDirectoryRecursive(fakeFs(), '/w')).toEqual([
			{ name: 'a.txt', path: 'a.txt', type: 'file', size: 3, mimeType: 'text/plain' },
			{ name: 'sub', path: 'sub', type: 'directory', size: 0 },
			{ name: 'b.txt', path: 'sub/b.txt', type: 'file', size: 7, mimeType: 'text/plain' },
		])
	})

	test('runs the whole walk inside one scope when the platform has one', async () => {
		let open = 0
		let maxOpen = 0
		let readsOutsideScope = 0
		const fs = fakeFs(() => {
			if (open === 0) readsOutsideScope++
		})
		fs.scopeReads = async <T>(fn: () => Promise<T>): Promise<T> => {
			open++
			maxOpen = Math.max(maxOpen, open)
			try {
				return await fn()
			} finally {
				open--
			}
		}

		const entries = await listDirectoryRecursive(fs, '/w')

		// One scope for the whole walk, and nothing read outside it.
		expect(maxOpen).toBe(1)
		expect(readsOutsideScope).toBe(0)
		// The hint changes nothing about the answer.
		expect(entries).toEqual(await listDirectoryRecursive(fakeFs(), '/w'))
	})

	test('asks a platform that walks whole for the subtree, and reads nothing else', async () => {
		let listings = 0
		let walks = 0
		const fs = fakeFs(() => listings++)
		fs.walk = async (dir: string, options?: WalkOptions): Promise<WalkEntry[]> => {
			walks++
			// The caller's skips travel with the question rather than being applied
			// to what comes back.
			expect(options?.excludeHidden).toBe(true)
			expect(options?.exclude).toContain('node_modules')
			const out: WalkEntry[] = []
			const descend = (path: string): void => {
				for (const name of TREE[path] ?? []) {
					const child = `${path}/${name}`
					const isDir = TREE[child] !== undefined
					out.push({
						path: child,
						type: isDir ? 'directory' : 'file',
						size: SIZES[child] ?? 0,
						mtime: 0,
					})
					if (isDir) descend(child)
				}
			}
			descend(dir)
			return out
		}

		const entries = await listDirectoryRecursive(fs, '/w')

		expect(walks).toBe(1)
		expect(listings).toBe(0)
		// And it is the same answer the walk built one readdir at a time.
		expect(entries).toEqual(await listDirectoryRecursive(fakeFs(), '/w'))
	})
})
