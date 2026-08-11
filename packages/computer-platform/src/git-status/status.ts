/**
 * `git status`, answered from SQLite and the git index instead of from a walk.
 *
 * What it replaces costs ~0.6 ms per filesystem node and touches every one of
 * them: on a cloned site of 7,657 files a `git status` with nothing to report
 * takes 9.7 s, and an editor asks for one after every save. Measured against
 * the same repository this answers in ~65 ms, because the tree walk is a
 * recursive CTE (61 ms) and only the paths whose stat moved are ever read.
 *
 * The comparison is the one git itself makes: the working tree against
 * `.git/index`. The index is what makes this possible without any state of our
 * own — it records, per path, the blob git has and the size and mtime the file
 * had when git last looked. A path whose size and mtime still match cannot have
 * been written since, so it is clean without reading a byte; everything else is
 * hashed and compared against the recorded blob.
 *
 * Two things are deliberately left to the binding rather than approximated:
 *
 *   - The staged half of the XY pair. Knowing whether the index differs from
 *     HEAD means reading HEAD's tree, and that measured 50 s on the same
 *     repository — so `index` is always reported as clean here. A path staged
 *     with `git add` whose working copy matches what was staged is therefore not
 *     reported. In this host nothing stages without committing in the same
 *     breath, so that is a window rather than a state.
 *   - Anything the reader will not vouch for — a v3/v4 index, an unmerged path,
 *     a submodule, a mounted node, `core.autocrlf` — returns `undefined`, and
 *     the caller runs the git binding it would have run anyway.
 */

import type { GitClient as ComputerGitClient } from '@cloudflare/computer/git'
import type { FileSystem, GitStatusEntry } from '@roj-ai/sdk/platform'
import type { VfsSource } from '../vfs-source.js'
import { IGNORE_FILE, createIgnoreMatcher } from './ignore.js'
import { parseGitIndex } from './index-file.js'
import type { GitIndexEntry } from './index-file.js'
import { findRootInode, listWorktree, readNode, resolveInode } from './tree.js'
import type { WorktreeFile } from './tree.js'

const SYMLINK_MODE = 0o120000
const INDEX_PATH = '.git/index'

export type NativeGitStatus = (dir: string) => Promise<GitStatusEntry[] | undefined>

export interface NativeGitStatusOptions {
	db: VfsSource
	git: ComputerGitClient
	fs: FileSystem
}

/** Parsed `.git/index`, held against the mtime of the file it was parsed from. */
interface CachedIndex {
	mtimeMs: number
	size: number
	entries: Map<string, GitIndexEntry>
}

function trimTrailingSlash(path: string): string {
	return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/** Directories holding a `.gitignore`, taken from the listing rather than probed for. */
function ignoreSources(files: readonly WorktreeFile[]): Set<string> {
	const sources = new Set<string>()
	for (const file of files) {
		if (file.path === IGNORE_FILE) sources.add('')
		else if (file.path.endsWith(`/${IGNORE_FILE}`)) sources.add(file.path.slice(0, -(IGNORE_FILE.length + 1)))
	}
	return sources
}

export function createNativeGitStatus(options: NativeGitStatusOptions): NativeGitStatus {
	const { db, git, fs } = options
	const indexes = new Map<string, CachedIndex>()
	let rootInode: number | undefined

	/** `undefined` for a file that is not there, which is not an error here. */
	const readText = async (path: string): Promise<string | undefined> => {
		try {
			return await fs.readFile(path, 'utf-8')
		} catch {
			return undefined
		}
	}

	/**
	 * Whether the index may hold something this cannot express.
	 *
	 * isomorphic-git normalises line endings when `core.autocrlf` is on, so the
	 * bytes on disk are not the bytes it hashed and a hash taken here would not
	 * match. Nothing sets it in this host; where something has, the binding wins.
	 */
	const usesLineEndingFilters = async (dir: string): Promise<boolean> => {
		try {
			const value = await git.configGet({ dir, path: 'core.autocrlf' })
			if (value === undefined) return false
			const setting = Array.isArray(value) ? value.at(-1) : value
			// `String` because the config reader coerces known booleans, and an
			// explicit `false` must not cost the optimisation.
			return setting !== undefined && String(setting).toLowerCase() !== 'false'
		} catch {
			return false
		}
	}

	const loadIndex = async (dir: string, mtimeMs: number, size: number): Promise<Map<string, GitIndexEntry> | undefined> => {
		const cached = indexes.get(dir)
		if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.entries

		const entries = parseGitIndex(await fs.readFile(`${dir}/${INDEX_PATH}`))
		if (entries === undefined) {
			indexes.delete(dir)
			return undefined
		}
		indexes.set(dir, { mtimeMs, size, entries })
		return entries
	}

	const hashOf = async (dir: string, content: Uint8Array | string): Promise<string> =>
		await git.hashObject({ dir, content })

	/**
	 * Whether a tracked path differs from what the index recorded for it.
	 *
	 * Size and mtime are the stat cache, and a match there ends it — that is what
	 * keeps a clean tree off the content of its own files. Everything else is
	 * hashed, so a file rewritten with the bytes it already had comes out clean
	 * and the count never drifts above what git would report.
	 */
	const differs = async (dir: string, file: WorktreeFile, entry: GitIndexEntry): Promise<boolean> => {
		if ((entry.mode === SYMLINK_MODE) !== file.symlink) return true
		if (file.symlink) {
			const target = file.target
			// A symlink git hashes by its target, which the row already carries.
			return target === undefined || await hashOf(dir, target) !== entry.oid
		}
		if (file.size === entry.size && file.mtimeMs === entry.mtimeMs) return false
		if (file.size !== entry.size) return true
		return await hashOf(dir, await fs.readFile(`${dir}/${file.path}`)) !== entry.oid
	}

	const read = async (raw: string): Promise<GitStatusEntry[] | undefined> => {
		const dir = trimTrailingSlash(raw)
		rootInode ??= findRootInode(db)
		if (rootInode === undefined) return undefined

		const workInode = resolveInode(db, rootInode, dir)
		if (workInode === undefined) return undefined
		const gitInode = resolveInode(db, workInode, '.git')
		// A `.git` file rather than a directory is a linked worktree or a submodule,
		// and the index it points at is somewhere this does not look.
		if (gitInode === undefined || readNode(db, gitInode)?.type !== 'dir') return undefined

		const indexInode = resolveInode(db, gitInode, 'index')
		if (indexInode === undefined) return undefined
		const indexNode = readNode(db, indexInode)
		if (indexNode?.type !== 'file') return undefined

		if (await usesLineEndingFilters(dir)) return undefined
		const index = await loadIndex(dir, indexNode.mtimeMs, indexNode.size)
		if (index === undefined) return undefined

		const files = listWorktree(db, workInode)
		if (files === undefined) return undefined

		const ignore = createIgnoreMatcher({
			read: (path) => readText(`${dir}/${path}`),
			sources: ignoreSources(files),
		})

		const entries: GitStatusEntry[] = []
		const present = new Set<string>()
		for (const file of files) {
			const tracked = index.get(file.path)
			if (tracked === undefined) {
				if (!await ignore.isIgnored(file.path)) entries.push({ path: file.path, index: ' ', worktree: '?' })
				continue
			}
			present.add(file.path)
			if (await differs(dir, file, tracked)) entries.push({ path: file.path, index: ' ', worktree: 'M' })
		}

		for (const path of index.keys()) {
			if (!present.has(path)) entries.push({ path, index: ' ', worktree: 'D' })
		}

		return entries
	}

	return async (dir) => {
		try {
			return await read(dir)
		} catch {
			// Every failure here is a failure of an optimisation, and the caller has a
			// slower answer that always works.
			return undefined
		}
	}
}
