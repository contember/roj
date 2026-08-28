import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { SessionFileStore } from './file-store.js'

let base: string
let root: string
let workspace: string
let outside: string
let store: SessionFileStore

beforeEach(() => {
	base = fs.mkdtempSync(path.join(tmpdir(), 'roj-file-store-'))
	root = path.join(base, 'session')
	workspace = path.join(base, 'workspace')
	outside = path.join(base, 'outside')
	for (const dir of [root, workspace, outside]) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(root, 'inside.txt'), 'inside')
	fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
	store = new SessionFileStore(root, undefined, false, createNodeFileSystem(), 'session')
})

afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true })
})

describe('SessionFileStore path containment', () => {
	it('reads through a link whose target stays inside the root', async () => {
		fs.symlinkSync(path.join(root, 'inside.txt'), path.join(root, 'link.txt'))

		const result = await store.read('link.txt')
		expect(result).toEqual({ ok: true, value: 'inside' })
	})

	it('reads through a linked directory inside the root', async () => {
		fs.mkdirSync(path.join(root, 'pkg'))
		fs.writeFileSync(path.join(root, 'pkg', 'index.js'), 'module')
		fs.mkdirSync(path.join(root, 'node_modules'))
		fs.symlinkSync(path.join(root, 'pkg'), path.join(root, 'node_modules', 'dep'))

		const result = await store.read('node_modules/dep/index.js')
		expect(result).toEqual({ ok: true, value: 'module' })
	})

	it('writes through a link whose target stays inside the root', async () => {
		fs.symlinkSync(path.join(root, 'inside.txt'), path.join(root, 'link.txt'))

		const result = await store.write('link.txt', 'rewritten')
		expect(result.ok).toBe(true)
		expect(fs.readFileSync(path.join(root, 'inside.txt'), 'utf-8')).toBe('rewritten')
	})

	it('rejects reading through a link that points outside the root', async () => {
		fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'))

		const result = await store.read('escape.txt')
		expect(result.ok).toBe(false)
		expect(result.ok ? '' : result.error).toContain('outside allowed directories')
	})

	it('rejects writing through a directory link that points outside the root', async () => {
		fs.symlinkSync(outside, path.join(root, 'escape'))

		const result = await store.write('escape/planted.txt', 'payload')
		expect(result.ok).toBe(false)
		expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false)
	})

	it('rejects listing a linked directory that points outside the root', async () => {
		fs.symlinkSync(outside, path.join(root, 'escape'))

		const result = await store.list('escape')
		expect(result.ok).toBe(false)
	})

	it('allows writing a new file under a path that does not exist yet', async () => {
		const result = await store.write('nested/deep/new.txt', 'created')
		expect(result.ok).toBe(true)
		expect(fs.readFileSync(path.join(root, 'nested', 'deep', 'new.txt'), 'utf-8')).toBe('created')
	})

	it('reports a link to a file as a file', async () => {
		fs.symlinkSync(path.join(root, 'inside.txt'), path.join(root, 'link.txt'))

		const result = await store.stat('link.txt')
		expect(result.ok && result.value.type).toBe('file')
	})

	it('rejects an agent path that escapes through a link in full scope', async () => {
		fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'))
		const fullStore = new SessionFileStore(root, undefined, false, createNodeFileSystem())

		const result = await fullStore.read(path.join(root, 'escape.txt'))
		expect(result.ok).toBe(false)
	})

	it('keeps a scoped sub-store inside the root it was carved out of', async () => {
		fs.mkdirSync(path.join(root, 'sub'))
		fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'sub', 'escape.txt'))

		const result = await store.scoped('sub').read('escape.txt')
		expect(result.ok).toBe(false)
	})

	it('returns a contained path for a caller that reaches the filesystem itself', async () => {
		fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'))

		expect(await store.containedPath('inside.txt')).toEqual({ ok: true, value: path.join(root, 'inside.txt') })
		expect((await store.containedPath('escape.txt')).ok).toBe(false)
	})
})

describe('SessionFileStore across both of its roots', () => {
	function bothRoots(): SessionFileStore {
		return new SessionFileStore(root, workspace, false, createNodeFileSystem())
	}

	it('allows a workspace link whose target is in the session root', async () => {
		fs.symlinkSync(path.join(root, 'inside.txt'), path.join(workspace, 'data.csv'))

		const result = await bothRoots().read(path.join(workspace, 'data.csv'))
		expect(result).toEqual({ ok: true, value: 'inside' })
	})

	it('allows a session link whose target is in the workspace root', async () => {
		fs.writeFileSync(path.join(workspace, 'built.txt'), 'built')
		fs.symlinkSync(path.join(workspace, 'built.txt'), path.join(root, 'built.link'))

		const result = await bothRoots().read(path.join(root, 'built.link'))
		expect(result).toEqual({ ok: true, value: 'built' })
	})

	it('still rejects a link that leaves both roots', async () => {
		fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'escape.txt'))

		const result = await bothRoots().read(path.join(workspace, 'escape.txt'))
		expect(result.ok).toBe(false)
	})
})

describe('SessionFileStore on a link it cannot resolve', () => {
	it('refuses to write through one, and does not create its target', async () => {
		// The guard the required `lstat` exists for: without it the path reads as
		// missing, the write follows the link, and the file lands outside the root.
		fs.symlinkSync(path.join(outside, 'planted.txt'), path.join(root, 'dangling.txt'))

		const result = await store.write('dangling.txt', 'payload')
		expect(result.ok).toBe(false)
		expect(result.ok ? '' : result.error).toContain('cannot be resolved')
		expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false)
	})

	it('removes it, because unlink acts on the link and not its target', async () => {
		fs.symlinkSync(path.join(root, 'gone.txt'), path.join(root, 'dangling.txt'))

		expect(await store.remove('dangling.txt')).toEqual({ ok: true, value: undefined })
		expect(fs.existsSync(path.join(root, 'dangling.txt'))).toBe(false)
	})

	it('reports it as absent rather than as an error', async () => {
		fs.symlinkSync(path.join(root, 'gone.txt'), path.join(root, 'dangling.txt'))

		expect(await store.exists('dangling.txt')).toEqual({ ok: true, value: false })
	})

	it('still refuses to remove one reached through a directory link that leaves the root', async () => {
		fs.symlinkSync(outside, path.join(root, 'escape'))

		const result = await store.remove('escape/secret.txt')
		expect(result.ok).toBe(false)
		expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true)
	})
})
