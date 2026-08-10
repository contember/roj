import { describe, expect, it } from 'bun:test'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import type { FileSystem } from '~/platform/fs.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'

/** Session-scoped store over a filesystem whose readFile always fails with `error`. */
function storeThatFailsWith(error: unknown): SessionFileStore {
	const fs: FileSystem = {
		...createNodeFileSystem(),
		readFile: async () => {
			throw error
		},
	}
	return new SessionFileStore('/tmp/roj-file-store-test', undefined, false, fs).session
}

describe('SessionFileStore.read', () => {
	it('reports a missing file as not found', async () => {
		const store = storeThatFailsWith(
			Object.assign(new Error("ENOENT: no such file or directory, open '/tmp/x/a.txt'"), { code: 'ENOENT' }),
		)

		const result = await store.read('a.txt')

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toBe('File not found: a.txt')
	})

	it('preserves the reason for a failure that is not a missing file', async () => {
		const store = storeThatFailsWith(
			Object.assign(new Error('File size (3000000000) is greater than 2 GiB'), { code: 'ERR_FS_FILE_TOO_LARGE' }),
		)

		const result = await store.read('big.bin')

		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error).toContain('big.bin')
			expect(result.error).toContain('File size (3000000000) is greater than 2 GiB')
			expect(result.error).not.toContain('not found')
		}
	})

	it('preserves the reason for a permission failure', async () => {
		const store = storeThatFailsWith(
			Object.assign(new Error("EACCES: permission denied, open '/tmp/x/secret'"), { code: 'EACCES' }),
		)

		const result = await store.read('secret', { type: 'buffer' })

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toContain('EACCES: permission denied')
	})

	it('describes a non-Error failure', async () => {
		const store = storeThatFailsWith('out of memory')

		const result = await store.read('a.txt')

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toContain('out of memory')
	})
})
