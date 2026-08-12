/**
 * A workspace fake for the git-status tests, shared by status and diff.
 *
 * Enough of the real thing to answer both questions: the `vfs_*` rows the
 * queries read, a filesystem over the same content, and the handful of git calls
 * that still reach the binding. Hashing is real SHA-1, so an oid that matches
 * here would match against git.
 *
 * Excluded from the package build in tsconfig.json — this is test scaffolding
 * that two test files happen to share, not part of the adapter.
 */

import type { GitClient as ComputerGitClient } from '@cloudflare/computer/git'
import type { FileSystem } from '@roj-ai/sdk/platform'
import { createHash } from 'node:crypto'
import type { VfsSource } from '../vfs-source.js'

export const WORKDIR = '/site'
const HEADER_BYTES = 12
const ENTRY_FIXED_BYTES = 62

/** The blob oid git would give this content — the fake binding hashes for real. */
export function blobOid(content: string): string {
	const bytes = Buffer.from(content, 'utf-8')
	return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

export interface IndexInput {
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
export function buildIndex(entries: IndexInput[]): Uint8Array {
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

export interface FakeFile {
	/** Absolute path in the fake filesystem. */
	path: string
	content?: string | Uint8Array
	/** Present for a symlink; `content` is then ignored. */
	target?: string
	mtimeMs: number
	/** Marks the node as coming from a mount, whose recorded size is a stub's. */
	mount?: boolean
}

export function bytesOf(content: string | Uint8Array): Buffer {
	return typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content)
}

export interface FakeWorkspace {
	db: VfsSource
	fs: FileSystem
	git: ComputerGitClient
}

export interface FakeWorkspaceOptions {
	autocrlf?: string
	/** Contents `catFile` can serve, keyed by the oid git would give them. */
	blobs?: string[]
}

/**
 * Enough of the workspace to answer a status: the `vfs_*` rows the queries read,
 * a filesystem over the same content, and the git calls that are still made.
 */
export function workspace(files: FakeFile[], options: FakeWorkspaceOptions = {}): FakeWorkspace {
	const blobs = new Map((options.blobs ?? []).map((content) => [blobOid(content), bytesOf(content)]))
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
			if (property === 'catFile') {
				return async (input: { oid: string }): Promise<{ oid: string; bytes: Uint8Array }> => {
					const bytes = blobs.get(input.oid)
					if (bytes === undefined) throw new Error(`no such object: ${input.oid}`)
					return { oid: input.oid, bytes }
				}
			}
			throw new Error(`unexpected git call: ${String(property)}`)
		},
	})

	return { db, fs, git }
}
