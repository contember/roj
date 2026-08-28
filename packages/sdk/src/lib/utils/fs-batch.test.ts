import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { countFsCalls, withReadFiles } from './fs-batch-doubles.test.js'
import { readFilesOrUndefined, readTextFilesOrUndefined } from './fs-batch.js'

async function withFixture(run: (paths: string[]) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'roj-fs-batch-'))
	try {
		await writeFile(join(root, 'first.txt'), 'first')
		await writeFile(join(root, 'third.txt'), 'third')
		await run([join(root, 'first.txt'), join(root, 'missing.txt'), join(root, 'third.txt')])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

describe('readFilesOrUndefined', () => {
	test('asks the platform once when it takes a set, and answers the same either way', async () => {
		await withFixture(async (paths) => {
			const loop = countFsCalls(createNodeFileSystem())
			const batch = countFsCalls(withReadFiles(createNodeFileSystem()))

			const viaLoop = await readTextFilesOrUndefined(loop.fs, paths)
			const viaBatch = await readTextFilesOrUndefined(batch.fs, paths)

			expect(viaLoop).toEqual(['first', undefined, 'third'])
			expect(viaBatch).toEqual(viaLoop)
			// One question instead of three, and the loop never runs behind it.
			expect(batch.calls).toEqual({ readFiles: 1 })
			expect(loop.calls).toEqual({ readFile: 3 })
		})
	})

	test('returns bytes in the order asked for', async () => {
		await withFixture(async (paths) => {
			const read = await readFilesOrUndefined(withReadFiles(createNodeFileSystem()), paths)
			expect(read.map((bytes) => bytes?.toString('utf-8'))).toEqual(['first', undefined, 'third'])
		})
	})

	test('asks nothing at all for an empty list', async () => {
		const { fs, calls } = countFsCalls(withReadFiles(createNodeFileSystem()))
		expect(await readFilesOrUndefined(fs, [])).toEqual([])
		expect(calls).toEqual({})
	})
})
