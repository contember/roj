import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { containmentOf } from './containment.js'

let root: string

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), 'roj-containment-')))
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

describe('containmentOf', () => {
	test('a directory another writer creates between realpath and lstat is inside, not a dangling link', async () => {
		const node = createNodeFileSystem()
		const dir = join(root, '.images')
		let raced = false
		const fs = {
			...node,
			realpath: async (path: string) => {
				if (path === dir && !raced) {
					raced = true
					const missing = node.realpath(path)
					mkdirSync(dir)
					return missing
				}
				return node.realpath(path)
			},
		}

		expect(await containmentOf(fs, [root], join(dir, 'a.png'))).toBe('inside')
	})

	test('a link with no target is still unresolvable', async () => {
		symlinkSync(join(root, 'gone'), join(root, 'dangling'))

		expect(await containmentOf(createNodeFileSystem(), [root], join(root, 'dangling', 'a.png'))).toBe('unresolvable')
	})
})
