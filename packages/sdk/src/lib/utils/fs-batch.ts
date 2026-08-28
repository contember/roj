/**
 * Reading a known set of files, however the platform prefers to be asked.
 *
 * `FileSystem.readFiles` is optional — a plain node:fs platform has no use for
 * it, a database-backed one answers a whole set in about the work it spends on
 * one file. Every caller with a list of paths wants the same two things from
 * that difference: the batch where it exists, and the loop where it does not,
 * with a missing file reported rather than thrown either way.
 *
 * So it lives here once instead of at each call site.
 */

import type { FileSystem } from '~/platform/fs.js'
import { mapWithConcurrency } from './concurrency.js'

/** Files read at once when the platform has no batch verb. */
const READ_CONCURRENCY = 16

/** Every path's bytes, in order, `undefined` where there was nothing to read. */
export async function readFilesOrUndefined(
	fs: FileSystem,
	paths: readonly string[],
): Promise<(Buffer | undefined)[]> {
	if (paths.length === 0) return []

	if (fs.readFiles) {
		const read = await fs.readFiles(paths)
		return paths.map((_path, index) => read[index]?.content)
	}

	return mapWithConcurrency(paths, READ_CONCURRENCY, (path) => readOrUndefined(fs, path))
}

/** The same, decoded as UTF-8. */
export async function readTextFilesOrUndefined(
	fs: FileSystem,
	paths: readonly string[],
): Promise<(string | undefined)[]> {
	const read = await readFilesOrUndefined(fs, paths)
	return read.map((bytes) => bytes?.toString('utf-8'))
}

async function readOrUndefined(fs: FileSystem, path: string): Promise<Buffer | undefined> {
	try {
		return await fs.readFile(path)
	} catch {
		return undefined
	}
}
