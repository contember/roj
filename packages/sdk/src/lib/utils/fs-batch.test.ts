import { describe, expect, test } from 'bun:test'
import type { FileSystem, ReadFilesEntry } from '~/platform/fs.js'
import { readFilesOrUndefined, readTextFilesOrUndefined } from './fs-batch.js'

const CONTENT: Record<string, string> = { '/a': 'first', '/b': 'second', '/c': 'third' }

/** Just enough filesystem to read; `seen` records what was asked and how. */
function fakeFs(seen: { single: string[]; batched: string[][] }, batch: boolean): FileSystem {
	const fs = {
		readFile: (async (path: string) => {
			seen.single.push(path)
			const body = CONTENT[path]
			if (body === undefined) throw new Error(`ENOENT: ${path}`)
			return Buffer.from(body, 'utf-8')
		}) as FileSystem['readFile'],
	} as FileSystem
	if (batch) {
		fs.readFiles = async (paths: readonly string[]): Promise<ReadFilesEntry[]> => {
			seen.batched.push([...paths])
			return paths.map((path) => {
				const body = CONTENT[path]
				return body === undefined ? { path, error: 'ENOENT' } : { path, content: Buffer.from(body, 'utf-8') }
			})
		}
	}
	return fs
}

describe('readFilesOrUndefined', () => {
	test('answers in order, with a gap where there was nothing to read', async () => {
		const seen = { single: [], batched: [] as string[][] }
		const read = await readFilesOrUndefined(fakeFs(seen, false), ['/a', '/missing', '/c'])
		expect(read.map((bytes) => bytes?.toString('utf-8'))).toEqual(['first', undefined, 'third'])
	})

	test('asks the platform once when it takes a set, and gives the same answer', async () => {
		const loop = { single: [] as string[], batched: [] as string[][] }
		const batch = { single: [] as string[], batched: [] as string[][] }
		const paths = ['/a', '/missing', '/c']

		const viaLoop = await readTextFilesOrUndefined(fakeFs(loop, false), paths)
		const viaBatch = await readTextFilesOrUndefined(fakeFs(batch, true), paths)

		expect(viaBatch).toEqual(viaLoop)
		expect(viaLoop).toEqual(['first', undefined, 'third'])
		// One question instead of three, and the loop never runs behind it.
		expect(batch.batched).toEqual([paths])
		expect(batch.single).toEqual([])
		expect(loop.single).toEqual(paths)
	})

	test('asks nothing at all for an empty list', async () => {
		const seen = { single: [] as string[], batched: [] as string[][] }
		expect(await readFilesOrUndefined(fakeFs(seen, true), [])).toEqual([])
		expect(seen.batched).toEqual([])
		expect(seen.single).toEqual([])
	})
})
