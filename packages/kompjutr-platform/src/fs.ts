/**
 * `FileSystem` port over a kompjutr workspace.
 *
 * kompjutr ships a node:fs-shaped shim (`NodeFsCompat`) over its own bulk-first
 * `Filesystem`, and the shim already answers the port's optional verbs in the
 * shape the port asks for. So most of this file forwards. What it does not
 * forward is what the shim does not do, or does with different semantics than
 * the port states — `appendFile`, a recursive `cp`, and a walk's symlink sizes.
 */

import type { Filesystem, NodeFsCompat, Stat } from '@kompjutr/do'
import type { FileSystem, ReadableFileHandle, ReadFilesEntry, WalkEntry, WalkOptions, WriteFilesEntry, WriteFilesOptions } from '@roj-ai/sdk/platform'

/** Pages a subtree scan. kompjutr caps a page at 1,000 rows. */
const SCAN_PAGE = 1_000

/** What `Filesystem.copyFiles` accepts in one call. */
const COPY_BATCH = 1_000

export interface KompjutrFileSystemOptions {
	/** The node:fs-shaped shim. `Workspace.fs`. */
	compat: NodeFsCompat
	/** The bulk API underneath it, over the same database. `Workspace.filesystem`. */
	filesystem: Filesystem
}

function toBytes(data: string | Uint8Array): Uint8Array {
	return typeof data === 'string' ? new TextEncoder().encode(data) : data
}

function fileError(code: string, path: string, message: string): Error {
	return Object.assign(new Error(`${message}: ${path}`), { code, path })
}

/** The port's `type`, which names a directory in full and admits things kompjutr cannot produce. */
function walkType(type: Stat['type']): WalkEntry['type'] {
	if (type === 'dir') return 'directory'
	return type
}

export function createKompjutrFileSystem(options: KompjutrFileSystemOptions): FileSystem {
	const { compat, filesystem } = options

	/** Every path under `root`, parents before children. Excludes `root` itself. */
	const scanSubtree = (root: string): string[] => {
		const paths: string[] = []
		let after: string | undefined
		for (;;) {
			const page = filesystem.scan(root, { after, limit: SCAN_PAGE })
			if (page.length === 0) return paths
			for (const entry of page) paths.push(entry.path)
			if (page.length < SCAN_PAGE) return paths
			after = page[page.length - 1]?.path
		}
	}

	/** Copies inside SQLite, so file bytes never enter the isolate. */
	const copyEntries = (entries: { source: string; destination: string }[], force = true): void => {
		let pending = entries.filter(({ source, destination }) => {
			const sourceStat = filesystem.stat(source)
			const destinationStat = filesystem.stat(destination)
			if (sourceStat !== null && destinationStat !== null && sourceStat.ino === destinationStat.ino) {
				throw fileError('ERR_FS_CP_EINVAL', destination, 'source and destination are the same file')
			}
			if (sourceStat?.type === 'dir' && destinationStat !== null && destinationStat.type !== 'dir') {
				throw fileError('ERR_FS_CP_DIR_TO_NON_DIR', destination, 'cannot overwrite a non-directory with a directory')
			}
			if (sourceStat?.type !== 'dir' && destinationStat?.type === 'dir') {
				throw fileError('ERR_FS_CP_NON_DIR_TO_DIR', destination, 'cannot overwrite a directory with a non-directory')
			}
			return force || destinationStat === null || sourceStat?.type === 'dir'
		})
		while (pending.length > 0) {
			const batch = filesystem.copyFiles(pending.slice(0, COPY_BATCH), {
				parents: true,
			})
			const deferred = [...batch.remaining, ...pending.slice(COPY_BATCH)]
			if (deferred.length >= pending.length) throw fileError('EIO', pending[0]?.source ?? '', 'copy made no progress')
			pending = deferred
		}
	}

	const remove = (path: string, rmOptions?: { recursive?: boolean; force?: boolean }): void => {
		if (!rmOptions?.recursive && filesystem.stat(path)?.type === 'dir') {
			throw fileError('ERR_FS_EISDIR', path, 'is a directory')
		}
		compat.rmSync(path, rmOptions)
	}

	return {
		// Every method here is `async`, and deliberately so: kompjutr's shim reaches
		// its synchronous core through `Promise.resolve(xSync(...))`, so a failure
		// throws where the port says it rejects. `async` puts that back.
		readFile: (async (path: string, encoding?: 'utf-8' | 'utf8') =>
			encoding ? compat.readFileSync(path, { encoding }) : compat.readFileSync(path)) as FileSystem['readFile'],

		writeFile: async (path, data) => {
			compat.writeFileSync(path, data)
		},

		// The shim's own appendFile is ENOSYS; write at the current end instead.
		appendFile: async (path, data) => {
			const stat = filesystem.statTarget(path)
			if (stat === null) {
				compat.writeFileSync(path, data)
				return
			}
			filesystem.writeRange(path, toBytes(data), stat.size)
		},

		mkdir: async (path, mkdirOptions) => {
			compat.mkdirSync(path, mkdirOptions)
		},

		readdir: (async (path: string, readdirOptions?: { withFileTypes: true }) =>
			readdirOptions?.withFileTypes ? compat.readdirSync(path, { withFileTypes: true }) : compat.readdirSync(path)) as FileSystem['readdir'],

		stat: async (path) => compat.statSync(path),
		lstat: async (path) => compat.lstatSync(path),
		access: async (path, mode) => {
			compat.accessSync(path, mode)
		},

		unlink: async (path) => {
			compat.unlinkSync(path)
		},

		rm: async (path, rmOptions) => {
			remove(path, rmOptions)
		},

		cp: async (source, dest, cpOptions) => {
			const stat = filesystem.stat(source)
			if (stat === null) throw fileError('ENOENT', source, 'no such file or directory')
			if (stat.type !== 'dir') {
				copyEntries([{ source, destination: dest }], cpOptions?.force)
				return
			}
			if (!cpOptions?.recursive) throw fileError('EISDIR', source, 'is a directory')
			const root = filesystem.realpath(source)
			copyEntries(
				[
					{ source: root, destination: dest },
					...scanSubtree(root).map((path) => ({
						source: path,
						destination: `${dest}${path.slice(root.length)}`,
					})),
				],
				cpOptions?.force,
			)
		},

		// The shim exposes fds, not handles; wrap one in the read subset the port uses.
		open: async (path, flags): Promise<ReadableFileHandle> => {
			const fd = compat.openSync(path, flags ?? 'r')
			return {
				stat: async () => compat.fstatSync(fd),
				read: async (buffer, offset, length, position) => ({
					bytesRead: compat.readSync(fd, buffer, offset, length, position),
					buffer,
				}),
				close: async () => {
					compat.closeSync(fd)
				},
			}
		},

		exists: async (path) => compat.existsSync(path),
		realpath: async (path) => compat.realpathSync(path),

		walk: async (dir: string, walkOptions?: WalkOptions): Promise<WalkEntry[]> => {
			const entries = await compat.walk(dir, walkOptions)
			return entries.map((entry) => ({
				path: entry.path,
				type: walkType(entry.type),
				// The shim reports a symlink's own size; the port wants the target's,
				// because the readdir-and-stat loop it replaces follows the link.
				size: entry.type === 'symlink' ? (filesystem.statTarget(entry.path)?.size ?? 0) : entry.size,
				mtime: entry.mtime,
			}))
		},

		readFiles: async (paths: readonly string[]): Promise<ReadFilesEntry[]> => {
			try {
				const entries = await compat.readFiles(paths)
				return entries.map((entry, index) => ({
					path: paths[index] ?? entry.path,
					...(entry.content === undefined ? {} : { content: Buffer.from(entry.content) }),
					...(entry.error === undefined ? {} : { error: entry.error }),
				}))
			} catch (error) {
				if (!(error instanceof Error) || !('code' in error) || (error.code !== 'ENOTDIR' && error.code !== 'ELOOP')) throw error
				// Path resolution can abort the upstream batch before it reports individual failures.
				return Promise.all(
					paths.map(async (path): Promise<ReadFilesEntry> => {
						try {
							const [entry] = await compat.readFiles([path])
							if (!entry) throw new Error('readFiles returned no entry')
							return {
								path,
								...(entry.content === undefined ? {} : { content: Buffer.from(entry.content) }),
								...(entry.error === undefined ? {} : { error: entry.error }),
							}
						} catch (entryError) {
							if (entryError instanceof Error && 'code' in entryError && typeof entryError.code === 'string') {
								return { path, error: entryError.code }
							}
							throw entryError
						}
					}),
				)
			}
		},

		// The bulk primitive replaces final links; resolve them as single writes do.
		writeFiles: async (entries: readonly WriteFilesEntry[], writeOptions?: WriteFilesOptions) => {
			filesystem.writeFiles(
				entries.map((entry) => ({
					path: filesystem.realpath(entry.path),
					bytes: toBytes(entry.content),
				})),
				{ parents: writeOptions?.createParents ?? false },
			)
		},

		rmFiles: async (paths: readonly string[], rmOptions?: { recursive?: boolean; force?: boolean }) => {
			for (const path of paths) remove(path, rmOptions)
		},

		scopeReads: (fn) => filesystem.withReadScope(fn),
	}
}
