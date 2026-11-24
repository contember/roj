import { createHash } from 'node:crypto'
import type { FileStore } from '~/core/file-store/types.js'
import { readImageMimeType } from './dimensions.js'

/** Session-store directory of resized images: removed with the session, and a fork starts without it. */
export const IMAGE_CACHE_DIR = '.image-cache'

/** The resize options that change the resizer's output. */
export interface ResizeCacheOptions {
	maxDimension: number
	maxFileSizeBytes: number
}

export interface CachedImage {
	bytes: Buffer
	mimeType: string
}

/**
 * Where a resize of these source bytes, read as `mimeType`, with these options is kept.
 * Everything that decides the output is in the name, so a changed option never reads an older result.
 */
export function resizeCachePath(source: Uint8Array, mimeType: string, options: ResizeCacheOptions): string {
	const hash = createHash('sha256').update(source).digest('hex')
	return `${IMAGE_CACHE_DIR}/${hash}.${mimeType.replace('/', '-')}.${options.maxDimension}px.${options.maxFileSizeBytes}b`
}

/** A cached resize, or undefined on a miss; a failed read or an entry that is not an image is a miss too. */
export async function readCachedResize(store: FileStore, path: string): Promise<CachedImage | undefined> {
	try {
		const read = await store.read(path, { type: 'buffer' })
		if (!read.ok) return undefined
		const mimeType = readImageMimeType(read.value)
		return mimeType === undefined ? undefined : { bytes: read.value, mimeType }
	} catch {
		return undefined
	}
}

/** Keeps a resize for later turns. A failed write only costs a resize next time, so it is logged, never thrown. */
export async function writeCachedResize(store: FileStore, path: string, image: CachedImage): Promise<void> {
	// A hit reads the type back from the bytes, so bytes that do not carry the declared type are not kept.
	if (readImageMimeType(image.bytes) !== image.mimeType) return
	try {
		const written = await store.write(path, image.bytes, { atomic: true })
		if (!written.ok) console.warn(`[ImageProcessor] Could not cache resized image ${path}: ${written.error}`)
	} catch (error) {
		console.warn(`[ImageProcessor] Could not cache resized image ${path}:`, error instanceof Error ? error.message : error)
	}
}
