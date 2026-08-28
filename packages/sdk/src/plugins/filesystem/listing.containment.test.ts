/**
 * `listDirectory` over a link that leaves the root it was given — on both the
 * `walk` platform and the readdir loop, since either can serve the listing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withBatchVerbs } from '~/lib/utils/fs-batch-doubles.test.js'
import type { FileSystem } from '~/platform/fs.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { listDirectory, ListingError } from './listing.js'

let base: string
let root: string
let outside: string

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), 'roj-listing-containment-'))
	root = join(base, 'root')
	outside = join(base, 'outside')
	await mkdir(join(root, 'sub'), { recursive: true })
	await mkdir(outside, { recursive: true })
	await writeFile(join(root, 'sub', 'ok.txt'), 'ok')
	await writeFile(join(outside, 'secret.txt'), 'secret')
	await symlink(outside, join(root, 'escape'))
})

afterEach(async () => {
	await rm(base, { recursive: true, force: true })
})

const platforms: [string, () => FileSystem][] = [
	['the readdir loop', () => createNodeFileSystem()],
	['a platform that answers walk', () => withBatchVerbs(createNodeFileSystem())],
]

describe.each(platforms)('listDirectory on %s', (_name, makeFs) => {
	it('refuses a sub-path that resolves out of the root', async () => {
		await expect(listDirectory(makeFs(), root, 'escape')).rejects.toThrow(
			new ListingError('forbidden', 'Path traversal not allowed'),
		)
	})

	it('still lists a sub-path that stays inside it', async () => {
		expect(await listDirectory(makeFs(), root, 'sub')).toEqual([
			{ name: 'ok.txt', type: 'file', size: 2, mimeType: 'text/plain' },
		])
	})
})
