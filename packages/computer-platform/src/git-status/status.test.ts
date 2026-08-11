import { describe, expect, test } from 'bun:test'
import type { GitClient as ComputerGitClient } from '@cloudflare/computer/git'
import type { FileSystem, GitStatusEntry } from '@roj-ai/sdk/platform'
import { createHash } from 'node:crypto'
import type { VfsSource } from '../vfs-source.js'
import { createNativeGitStatus } from './status.js'

const WORKDIR = '/site'
const HEADER_BYTES = 12
const ENTRY_FIXED_BYTES = 62

/** The blob oid git would give this content — the fake binding hashes for real. */
function blobOid(content: string): string {
	const bytes = Buffer.from(content, 'utf-8')
	return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

interface IndexInput {
	path: string
	content: string
	mtimeMs: number
	mode?: number
}

/**
 * A version-2 index, laid out the way git lays one out.
 *
 * Hand-written on purpose: the reader is pinned against a real git index in
 * index-file.test.ts, so this only has to produce something that reader accepts.
 */
function buildIndex(entries: IndexInput[]): Uint8Array {
	const encoder = new TextEncoder()
	const parts: Uint8Array[] = []
	const header = new Uint8Array(HEADER_BYTES)
	const headerView = new DataView(header.buffer)
	headerView.setUint32(0, 0x44495243)
	headerView.setUint32(4, 2)
	headerView.setUint32(8, entries.length)
	parts.push(header)

	let offset = HEADER_BYTES
	for (const entry of entries) {
		const name = encoder.encode(entry.path)
		const nul = offset + ENTRY_FIXED_BYTES + name.length
		const total = nul + (8 - ((nul - HEADER_BYTES) % 8)) - offset
		const buffer = new Uint8Array(total)
		const view = new DataView(buffer.buffer)
		const seconds = Math.floor(entry.mtimeMs / 1000)
		view.setUint32(8, seconds)
		view.setUint32(12, (entry.mtimeMs - seconds * 1000) * 1e6)
		view.setUint32(24, entry.mode ?? 0o100644)
		view.setUint32(36, Buffer.from(entry.content, 'utf-8').length)
		buffer.set(Buffer.from(blobOid(entry.content), 'hex'), 40)
		view.setUint16(60, Math.min(name.length, 0xfff))
		buffer.set(name, ENTRY_FIXED_BYTES)
		parts.push(buffer)
		offset += total
	}

	parts.push(new Uint8Array(20))
	const size = parts.reduce((total, part) => total + part.length, 0)
	const out = new Uint8Array(size)
	let cursor = 0
	for (const part of parts) {
		out.set(part, cursor)
		cursor += part.length
	}
	return out
}

interface FakeFile {
	/** Absolute path in the fake filesystem. */
	path: string
	content?: string | Uint8Array
	/** Present for a symlink; `content` is then ignored. */
	target?: string
	mtimeMs: number
	/** Marks the node as coming from a mount, whose recorded size is a stub's. */
	mount?: boolean
}

function bytesOf(content: string | Uint8Array): Buffer {
	return typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content)
}

interface FakeWorkspace {
	db: VfsSource
	fs: FileSystem
	git: ComputerGitClient
}

/**
 * Enough of the workspace to answer a status: the `vfs_*` rows the queries read,
 * a filesystem over the same content, and the two git calls that are still made.
 */
function workspace(files: FakeFile[], options: { autocrlf?: string } = {}): FakeWorkspace {
	const nodes = new Map<number, { type: string; size: number; mtimeMs: number; target?: string; mount?: boolean }>()
	const children = new Map<number, Map<string, number>>()
	const parents = new Map<number, number>()
	const content = new Map<string, Buffer>()
	const ROOT = 1
	let nextInode = 2

	nodes.set(ROOT, { type: 'dir', size: 0, mtimeMs: 0 })
	children.set(ROOT, new Map())

	const link = (parent: number, name: string, inode: number): void => {
		children.get(parent)?.set(name, inode)
		parents.set(inode, parent)
	}

	const ensureDir = (segments: string[]): number => {
		let current = ROOT
		for (const segment of segments) {
			const existing = children.get(current)?.get(segment)
			if (existing !== undefined) {
				current = existing
				continue
			}
			const inode = nextInode++
			nodes.set(inode, { type: 'dir', size: 0, mtimeMs: 0 })
			children.set(inode, new Map())
			link(current, segment, inode)
			current = inode
		}
		return current
	}

	for (const file of files) {
		const segments = file.path.split('/').filter((segment) => segment !== '')
		const name = segments.pop()
		if (name === undefined) continue
		const parent = ensureDir(segments)
		const inode = nextInode++
		const body = bytesOf(file.target ?? file.content ?? '')
		nodes.set(inode, {
			type: file.target === undefined ? 'file' : 'symlink',
			size: body.length,
			mtimeMs: file.mtimeMs,
			...(file.target === undefined ? {} : { target: file.target }),
			...(file.mount === true ? { mount: true } : {}),
		})
		link(parent, name, inode)
		if (file.target === undefined) content.set(file.path, body)
	}

	/** Every non-directory below `inode`, as the recursive query would return it. */
	const walk = (inode: number, prefix: string): unknown[] => {
		const rows: unknown[] = []
		for (const [name, child] of children.get(inode) ?? []) {
			if (prefix === '' && name === '.git') continue
			const node = nodes.get(child)
			if (node === undefined) continue
			const path = prefix === '' ? name : `${prefix}/${name}`
			if (node.type === 'dir') {
				rows.push(...walk(child, path))
				continue
			}
			rows.push({
				path,
				type: node.type,
				size: node.size,
				mtime: node.mtimeMs,
				target: node.target ?? null,
				mount: node.mount === true ? 'r2' : null,
			})
		}
		return rows
	}

	const db: VfsSource = {
		one(query, ...bindings) {
			if (query.includes('FROM vfs_dirents LIMIT 1')) return { inode: nextInode - 1 }
			if (query.includes('WHERE child_inode = ?')) {
				const parent = parents.get(Number(bindings[0]))
				return parent === undefined ? undefined : { parent }
			}
			if (query.includes('AND name = ?')) {
				const inode = children.get(Number(bindings[0]))?.get(String(bindings[1]))
				return inode === undefined ? undefined : { inode }
			}
			if (query.includes('FROM vfs_nodes WHERE inode')) {
				const node = nodes.get(Number(bindings[0]))
				return node === undefined ? undefined : { type: node.type, mtime: node.mtimeMs, size: node.size }
			}
			throw new Error(`unexpected query: ${query}`)
		},
		all(query, ...bindings) {
			if (query.includes('WITH RECURSIVE tree')) return walk(Number(bindings[0]), '')
			throw new Error(`unexpected query: ${query}`)
		},
	}

	const readFile = async (path: string, encoding?: 'utf-8' | 'utf8'): Promise<Buffer | string> => {
		const body = content.get(path)
		if (body === undefined) throw new Error(`ENOENT: ${path}`)
		return encoding === undefined ? body : body.toString('utf-8')
	}

	const fs: FileSystem = new Proxy({}, {
		get(_target, property) {
			if (property === 'readFile') return readFile
			throw new Error(`unexpected FileSystem call: ${String(property)}`)
		},
	})

	const git: ComputerGitClient = new Proxy({}, {
		get(_target, property) {
			if (property === 'hashObject') {
				return async (input: { content: Uint8Array | string }): Promise<string> =>
					blobOid(typeof input.content === 'string' ? input.content : Buffer.from(input.content).toString('utf-8'))
			}
			if (property === 'configGet') return async (): Promise<string | undefined> => options.autocrlf
			throw new Error(`unexpected git call: ${String(property)}`)
		},
	})

	return { db, fs, git }
}

/** A worktree with `.git/index` written for exactly the files listed as tracked. */
function scenario(options: {
	tracked: IndexInput[]
	worktree: FakeFile[]
	extra?: FakeFile[]
	autocrlf?: string
	indexBytes?: Uint8Array
}) {
	const index = options.indexBytes ?? buildIndex(options.tracked)
	const files: FakeFile[] = [
		...options.worktree,
		...options.extra ?? [],
		{ path: `${WORKDIR}/.git/index`, content: index, mtimeMs: 1 },
	]
	const fake = workspace(files, options.autocrlf === undefined ? {} : { autocrlf: options.autocrlf })
	return createNativeGitStatus(fake)
}

function sorted(entries: GitStatusEntry[] | undefined): GitStatusEntry[] | undefined {
	return entries?.slice().sort((a, b) => a.path.localeCompare(b.path))
}

const CLEAN: IndexInput[] = [
	{ path: 'a.txt', content: 'alpha\n', mtimeMs: 1_700_000_000_000 },
	{ path: 'src/b.txt', content: 'beta\n', mtimeMs: 1_700_000_001_000 },
]

const CLEAN_TREE: FakeFile[] = [
	{ path: `${WORKDIR}/a.txt`, content: 'alpha\n', mtimeMs: 1_700_000_000_000 },
	{ path: `${WORKDIR}/src/b.txt`, content: 'beta\n', mtimeMs: 1_700_000_001_000 },
]

describe('createNativeGitStatus', () => {
	test('reports nothing for a tree that matches its index', async () => {
		const status = scenario({ tracked: CLEAN, worktree: CLEAN_TREE })
		expect(await status(WORKDIR)).toEqual([])
	})

	test('reports a file whose content changed', async () => {
		const status = scenario({
			tracked: CLEAN,
			worktree: [
				{ path: `${WORKDIR}/a.txt`, content: 'alpha edited\n', mtimeMs: 1_700_000_500_000 },
				...CLEAN_TREE.slice(1),
			],
		})
		expect(await status(WORKDIR)).toEqual([{ path: 'a.txt', index: ' ', worktree: 'M' }])
	})

	// The filesystem revision moves on any write, so a rewrite with the same bytes
	// looks like an edit until something hashes it. Over-reporting here would put a
	// change in the publish bar that a commit would then find nothing to commit.
	test('reports nothing for a file rewritten with the bytes it already had', async () => {
		const status = scenario({
			tracked: CLEAN,
			worktree: [
				{ path: `${WORKDIR}/a.txt`, content: 'alpha\n', mtimeMs: 1_700_009_999_000 },
				...CLEAN_TREE.slice(1),
			],
		})
		expect(await status(WORKDIR)).toEqual([])
	})

	test('reports a tracked file that is gone', async () => {
		const status = scenario({ tracked: CLEAN, worktree: [CLEAN_TREE[0] ?? CLEAN_TREE[0]].filter((file) => file !== undefined) })
		expect(await status(WORKDIR)).toEqual([{ path: 'src/b.txt', index: ' ', worktree: 'D' }])
	})

	test('reports an untracked file', async () => {
		const status = scenario({
			tracked: CLEAN,
			worktree: CLEAN_TREE,
			extra: [{ path: `${WORKDIR}/new.txt`, content: 'new\n', mtimeMs: 1_700_000_900_000 }],
		})
		expect(await status(WORKDIR)).toEqual([{ path: 'new.txt', index: ' ', worktree: '?' }])
	})

	test('keeps an ignored file out of the count', async () => {
		const status = scenario({
			tracked: CLEAN,
			worktree: CLEAN_TREE,
			extra: [
				{ path: `${WORKDIR}/.gitignore`, content: 'dist/\n', mtimeMs: 1_700_000_002_000 },
				{ path: `${WORKDIR}/dist/bundle.js`, content: 'x\n', mtimeMs: 1_700_000_900_000 },
			],
		})
		// `.gitignore` itself is untracked here, and git reports that one.
		expect(sorted(await status(WORKDIR))).toEqual([{ path: '.gitignore', index: ' ', worktree: '?' }])
	})

	test('never looks inside .git', async () => {
		const status = scenario({
			tracked: CLEAN,
			worktree: CLEAN_TREE,
			extra: [{ path: `${WORKDIR}/.git/HEAD`, content: 'ref: refs/heads/main\n', mtimeMs: 1 }],
		})
		expect(await status(WORKDIR)).toEqual([])
	})

	test('reports a symlink by its target, not by a file read', async () => {
		const tracked: IndexInput[] = [{ path: 'link', content: 'src/b.txt', mtimeMs: 1_700_000_003_000, mode: 0o120000 }]
		const clean = scenario({
			tracked,
			worktree: [{ path: `${WORKDIR}/link`, target: 'src/b.txt', mtimeMs: 1_700_000_003_000 }],
		})
		expect(await clean(WORKDIR)).toEqual([])

		const moved = scenario({
			tracked,
			worktree: [{ path: `${WORKDIR}/link`, target: 'src/other.txt', mtimeMs: 1_700_000_004_000 }],
		})
		expect(await moved(WORKDIR)).toEqual([{ path: 'link', index: ' ', worktree: 'M' }])
	})

	test('reports a path that became a file where a symlink was', async () => {
		const status = scenario({
			tracked: [{ path: 'link', content: 'src/b.txt', mtimeMs: 1_700_000_003_000, mode: 0o120000 }],
			worktree: [{ path: `${WORKDIR}/link`, content: 'src/b.txt', mtimeMs: 1_700_000_003_000 }],
		})
		expect(await status(WORKDIR)).toEqual([{ path: 'link', index: ' ', worktree: 'M' }])
	})

	test('declines when the index is not one it reads', async () => {
		const status = scenario({ tracked: CLEAN, worktree: CLEAN_TREE, indexBytes: new Uint8Array(64) })
		expect(await status(WORKDIR)).toBeUndefined()
	})

	test('declines when there is no repository at the path', async () => {
		const fake = workspace([{ path: `${WORKDIR}/a.txt`, content: 'alpha\n', mtimeMs: 1 }])
		expect(await createNativeGitStatus(fake)(WORKDIR)).toBeUndefined()
	})

	test('declines when line endings are filtered, since the bytes on disk are not what git hashed', async () => {
		const status = scenario({ tracked: CLEAN, worktree: CLEAN_TREE, autocrlf: 'true' })
		expect(await status(WORKDIR)).toBeUndefined()
	})

	test('answers normally when line-ending filtering is explicitly off', async () => {
		const status = scenario({ tracked: CLEAN, worktree: CLEAN_TREE, autocrlf: 'false' })
		expect(await status(WORKDIR)).toEqual([])
	})

	test('declines when a mounted node is in the tree, whose recorded size is a stub', async () => {
		const status = scenario({
			tracked: CLEAN,
			worktree: CLEAN_TREE,
			extra: [{ path: `${WORKDIR}/assets/big.bin`, content: 'x', mtimeMs: 1, mount: true }],
		})
		expect(await status(WORKDIR)).toBeUndefined()
	})

	test('declines rather than throwing when the schema is gone', async () => {
		const broken: VfsSource = {
			one() {
				throw new Error('no such table: vfs_dirents')
			},
			all() {
				throw new Error('no such table: vfs_dirents')
			},
		}
		const fake = workspace(CLEAN_TREE)
		expect(await createNativeGitStatus({ ...fake, db: broken })(WORKDIR)).toBeUndefined()
	})
})
