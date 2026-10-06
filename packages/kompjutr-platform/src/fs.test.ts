import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Workspace } from '@kompjutr/do'
import { createKompjutrFileSystem } from './fs.js'
import { BunSqliteStorage } from './testing/storage.js'

let storage: BunSqliteStorage
let workspace: Workspace
let fs: ReturnType<typeof createKompjutrFileSystem>

beforeEach(() => {
	storage = new BunSqliteStorage()
	workspace = new Workspace({ storage })
	fs = createKompjutrFileSystem({ compat: workspace.fs, filesystem: workspace.filesystem })
})

afterEach(() => storage.close())

test('append follows the final symlink to the target EOF, including dangling targets', async () => {
	await fs.writeFile('/target', 'longer than the link target path')
	workspace.filesystem.symlink('/target', '/link')
	await fs.appendFile('/link', '!')
	expect(await fs.readFile('/target', 'utf8')).toBe('longer than the link target path!')
	expect((await fs.lstat('/link')).isSymbolicLink()).toBe(true)
	workspace.filesystem.symlink('/new', '/dangling')
	await fs.appendFile('/dangling', 'created')
	expect(await fs.readFile('/new', 'utf8')).toBe('created')
	expect((await fs.lstat('/dangling')).isSymbolicLink()).toBe(true)
})

test('cp force false preserves files and links and merges recursive directories', async () => {
	await fs.mkdir('/source/nested', { recursive: true })
	await fs.mkdir('/dest/nested', { recursive: true })
	await fs.writeFile('/source/nested/collision', 'source')
	await fs.writeFile('/source/nested/new', 'new')
	await fs.writeFile('/dest/nested/collision', 'destination')
	await fs.cp('/source', '/dest', { recursive: true, force: false })
	expect(await fs.readFile('/dest/nested/collision', 'utf8')).toBe('destination')
	expect(await fs.readFile('/dest/nested/new', 'utf8')).toBe('new')
	workspace.filesystem.symlink('/missing', '/link')
	await fs.cp('/source/nested/new', '/link', { force: false })
	expect((await fs.lstat('/link')).isSymbolicLink()).toBe(true)
	expect(await fs.exists('/missing')).toBe(false)
	await fs.cp('/source/nested/collision', '/dest/nested/collision')
	expect(await fs.readFile('/dest/nested/collision', 'utf8')).toBe('source')
})

for (const force of [true, false]) {
	for (const destination of ['/a', '/b', '/dir/../a']) {
		test(`cp rejects the same inode at ${destination} (force=${force})`, async () => {
			await fs.writeFile('/a', 'keep')
			await fs.mkdir('/dir')
			workspace.filesystem.link('/a', '/b')
			const original = await fs.lstat('/a')
			expect((await fs.lstat(destination)).ino).toBe(original.ino)
			await expect(fs.cp('/a', destination, { force })).rejects.toMatchObject({ code: 'ERR_FS_CP_EINVAL' })
			for (const path of ['/a', '/b']) {
				expect(await fs.readFile(path, 'utf8')).toBe('keep')
				const remaining = await fs.lstat(path)
				expect(remaining.ino).toBe(original.ino)
				expect(remaining.nlink).toBe(2)
			}
		})
	}

	test(`cp rejects incompatible destination types without replacing them (force=${force})`, async () => {
		await fs.mkdir('/dir')
		await fs.writeFile('/file', 'keep')
		await expect(fs.cp('/dir', '/file', { recursive: true, force })).rejects.toMatchObject({ code: 'ERR_FS_CP_DIR_TO_NON_DIR' })
		await expect(fs.cp('/file', '/dir', { recursive: true, force })).rejects.toMatchObject({ code: 'ERR_FS_CP_NON_DIR_TO_DIR' })
		expect(await fs.readFile('/file', 'utf8')).toBe('keep')
		expect((await fs.stat('/dir')).isDirectory()).toBe(true)
		await fs.mkdir('/source')
		await fs.mkdir('/dest/collision', { recursive: true })
		await fs.writeFile('/source/collision', 'file')
		await expect(fs.cp('/source', '/dest', { recursive: true, force })).rejects.toMatchObject({ code: 'ERR_FS_CP_NON_DIR_TO_DIR' })
		expect((await fs.stat('/dest/collision')).isDirectory()).toBe(true)
	})
}

test('bulk writes agree with single writes through existing and dangling final links', async () => {
	if (!fs.writeFiles) throw new Error('writeFiles is absent')
	for (const dangling of [false, true]) {
		const suffix = dangling ? 'dangling' : 'existing'
		for (const method of ['single', 'bulk']) {
			const target = `/${method}-${suffix}-target`
			const link = `/${method}-${suffix}-link`
			if (!dangling) await fs.writeFile(target, 'before')
			workspace.filesystem.symlink(target, link)
			if (method === 'single') await fs.writeFile(link, 'after')
			else await fs.writeFiles([{ path: link, content: 'after' }])
			expect(await fs.readFile(target, 'utf8')).toBe('after')
			expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
		}
	}
})

test('bulk writes preserve createParents for resolved link targets and ordinary paths', async () => {
	if (!fs.writeFiles) throw new Error('writeFiles is absent')
	workspace.filesystem.symlink('/missing/target', '/link')
	await expect(fs.writeFiles([{ path: '/link', content: 'data' }])).rejects.toMatchObject({ code: 'ENOENT' })
	await expect(fs.writeFiles([{ path: '/other/file', content: 'data' }], { createParents: false })).rejects.toMatchObject({ code: 'ENOENT' })
	await fs.writeFiles(
		[
			{ path: '/link', content: 'data' },
			{ path: '/other/file', content: 'ordinary' },
		],
		{ createParents: true },
	)
	expect(await fs.readFile('/missing/target', 'utf8')).toBe('data')
	expect(await fs.readFile('/other/file', 'utf8')).toBe('ordinary')
	expect((await fs.lstat('/link')).isSymbolicLink()).toBe(true)
})

test('bulk reads isolate path-resolution errors and preserve order, duplicates and successful bytes', async () => {
	if (!fs.readFiles) throw new Error('readFiles is absent')
	await fs.writeFile('/good', 'data')
	await fs.mkdir('/dir')
	workspace.filesystem.symlink('/loop', '/loop')
	const paths = ['/good', '/good/child', '/loop', '/absent', '/dir', '/good']
	expect(await fs.readFiles(paths)).toEqual([
		{ path: '/good', content: Buffer.from('data') },
		{ path: '/good/child', error: 'ENOTDIR' },
		{ path: '/loop', error: 'ELOOP' },
		{ path: '/absent', error: 'ENOENT' },
		{ path: '/dir', error: 'EISDIR' },
		{ path: '/good', content: Buffer.from('data') },
	])
	expect(await fs.readFiles(['/good', '/absent', '/good'])).toEqual([
		{ path: '/good', content: Buffer.from('data') },
		{ path: '/absent', error: 'ENOENT' },
		{ path: '/good', content: Buffer.from('data') },
	])
})

test('bulk removal keeps ordered partial effects when a later path is missing', async () => {
	if (!fs.rmFiles) throw new Error('rmFiles is absent')
	await fs.writeFile('/first', 'first')
	await fs.writeFile('/last', 'last')
	await expect(fs.rmFiles(['/first', '/missing', '/last'])).rejects.toMatchObject({ code: 'ENOENT' })
	expect(await fs.exists('/first')).toBe(false)
	expect(await fs.readFile('/last', 'utf8')).toBe('last')
	await fs.rmFiles(['/missing', '/last'], { force: true })
	expect(await fs.exists('/last')).toBe(false)
})

for (const bulk of [false, true]) {
	test(`nonrecursive removal rejects empty directories but removes final symlinks (bulk=${bulk})`, async () => {
		const remove = bulk
			? fs.rmFiles?.bind(fs)
			: async (paths: readonly string[], options?: { recursive?: boolean; force?: boolean }) => {
					for (const path of paths) await fs.rm(path, options)
				}
		if (!remove) throw new Error('rmFiles is absent')
		await fs.mkdir('/empty')
		workspace.filesystem.symlink('/empty', '/link')
		for (const force of [false, true]) {
			await expect(remove(['/empty'], { force })).rejects.toMatchObject({ code: 'ERR_FS_EISDIR' })
			expect((await fs.stat('/empty')).isDirectory()).toBe(true)
		}
		await remove(['/link'])
		await expect(fs.lstat('/link')).rejects.toMatchObject({ code: 'ENOENT' })
		expect((await fs.stat('/empty')).isDirectory()).toBe(true)
		await remove(['/empty'], { recursive: true })
		expect(await fs.exists('/empty')).toBe(false)
	})
}
