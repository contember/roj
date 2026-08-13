import { describe, expect, test } from 'bun:test'
import type { Dirent, FileSystem, Stats } from '~/platform/fs.js'
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
})
