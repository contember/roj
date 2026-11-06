import type { FileSystem } from './fs.js'

/**
 * Writes `content` to `pending` and renames it over `target`, so a reader sees the old bytes or the
 * new ones and a crash leaves one of them. `pending` must be in `target`'s directory; it is removed
 * if either step fails.
 */
export async function replaceViaRename(
	fs: FileSystem,
	rename: (source: string, dest: string) => Promise<void>,
	pending: string,
	target: string,
	content: string | Uint8Array,
): Promise<void> {
	try {
		await fs.writeFile(pending, content)
		await rename(pending, target)
	} finally {
		await fs.unlink(pending).catch(() => {})
	}
}
