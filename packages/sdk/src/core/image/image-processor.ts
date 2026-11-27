import { resolve } from 'node:path'
import type { FileStore } from '~/core/file-store/types.js'
import { STORED_IMAGE_PATH } from '~/core/llm/document-content.js'
import type { ChatMessageContentItem, ChatMessageContentItemImage, ChatMessageContentItemText, ToolResultContent } from '~/core/llm/llm-log-types.js'
import { getImageMimeType } from '~/lib/mime.js'
import type { FileSystem } from '~/platform/fs.js'
import { exceedsMaxDimension, MAX_IMAGE_DIMENSION, readImageDimensions } from './dimensions.js'
import { downscaleImage } from './js-resizer.js'
import { readCachedResize, resizeCachePath, type ResizeCacheOptions, UNCHANGED, writeCachedResize } from './resize-cache.js'
import type { ImageProcessor, ImageProcessorConfig, ImageResizer } from './types.js'

/** A resolved image, or the text that says why it could not be. */
type ResolvedImage = ChatMessageContentItemImage | ChatMessageContentItemText

const BASE64_DATA_URL = /^data:([^;,]*)(?:;[^;,]*)*;base64,/i

/**
 * An inline `data:` image over the dimension limit is downscaled in memory: an agent stores every one as a file, so
 * only a direct provider call sends one, and the processor has nowhere to write it for the resizer.
 */
function withinLimitInline(item: ChatMessageContentItemImage, maxFileSizeBytes: number): ResolvedImage {
	const match = BASE64_DATA_URL.exec(item.imageUrl.url)
	if (match === null) return item
	const bytes = Buffer.from(item.imageUrl.url.slice(match[0].length), 'base64')
	const dimensions = readImageDimensions(bytes)
	if (dimensions === undefined || !exceedsMaxDimension(dimensions)) return item
	try {
		const resized = downscaleImage(bytes, { maxDimension: MAX_IMAGE_DIMENSION, maxFileSizeBytes })
		return { type: 'image_url', imageUrl: { url: `data:image/jpeg;base64,${resized.toString('base64')}`, detail: item.imageUrl.detail } }
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		console.warn(`[ImageProcessor] Could not downscale an inline ${match[1] || 'image'} of ${dimensions.width}x${dimensions.height} px: ${reason}`)
		return {
			type: 'text',
			text: `[Image unavailable: inline ${match[1] || 'image'} - ${dimensions.width}x${dimensions.height} px, over the ${MAX_IMAGE_DIMENSION} px limit, and it could not be downscaled: ${reason}]`,
		}
	}
}

function formatFileSize(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export class DefaultImageProcessor implements ImageProcessor {
	constructor(
		private resizer: ImageResizer,
		private fs: FileSystem,
		private config: ImageProcessorConfig = { maxFileSizeBytes: 5 * 1024 * 1024 },
	) {}

	async resolveContent(content: ToolResultContent, fileStore?: FileStore): Promise<ToolResultContent> {
		if (typeof content === 'string') return content

		return Promise.all(
			content.map(async (item): Promise<ChatMessageContentItem> => {
				if (item.type !== 'image_url') return item
				// A remote URL is fetched by the provider itself, so its size is unknown here.
				if (!item.imageUrl.url.startsWith('file://')) return withinLimitInline(item, this.config.maxFileSizeBytes)

				const rawPath = item.imageUrl.url.slice(7)

				if (fileStore && STORED_IMAGE_PATH.test(rawPath)) return this.readStored(rawPath, item.imageUrl.detail, fileStore)

				if (fileStore) {
					const result = await this.resolveViaStore(rawPath, item.imageUrl.detail, fileStore)
					if (result.type === 'image_url') {
						const sizeKB = Math.round(result.imageUrl.url.length * 0.75 / 1024)
						console.log(`[ImageProcessor] Resolved image via store: ${rawPath} → ${sizeKB}KB base64`)
					} else {
						console.warn(`[ImageProcessor] Image resolution failed via store: ${rawPath} → ${result.text}`)
					}
					return result
				}

				const result = await this.resolveDirect(rawPath, item.imageUrl.detail)
				if (result.type === 'image_url') {
					const sizeKB = Math.round(result.imageUrl.url.length * 0.75 / 1024)
					console.log(`[ImageProcessor] Resolved image directly: ${rawPath} → ${sizeKB}KB base64`)
				} else {
					console.warn(`[ImageProcessor] Image resolution failed directly: ${rawPath} → ${result.text}`)
				}
				return result
			}),
		)
	}

	/**
	 * An image an agent stored from a `data:` URL, read from the session store, so a fork reads its own copy.
	 * Within the dimension limit it is sent as it arrived, since resizing would re-encode it; above, it is downscaled.
	 */
	private async readStored(path: string, detail: 'auto' | 'low' | 'high' | undefined, fileStore: FileStore): Promise<ResolvedImage> {
		const mimeType = getImageMimeType(path)
		if (!mimeType) return { type: 'text', text: `[Image unavailable: ${path} - unsupported format]` }
		const read = await fileStore.session.read(path, { type: 'buffer' })
		if (!read.ok) return { type: 'text', text: `[Image unavailable: ${path} - ${read.error}]` }
		const dimensions = readImageDimensions(read.value)
		if (dimensions !== undefined && exceedsMaxDimension(dimensions)) return this.resolveViaStore(path, detail, fileStore.session)
		return { type: 'image_url', imageUrl: { url: `data:${mimeType};base64,${read.value.toString('base64')}`, detail } }
	}

	private async resolveDirect(
		rawPath: string,
		detail: 'auto' | 'low' | 'high' | undefined,
	): Promise<ResolvedImage> {
		const filePath = resolve(rawPath)
		try {
			if (!(await this.fs.exists(filePath))) {
				return { type: 'text', text: `[Image unavailable: ${filePath} - file not found]` }
			}

			const mimeType = getImageMimeType(filePath)
			if (!mimeType) {
				return { type: 'text', text: `[Image unavailable: ${filePath} - unsupported format]` }
			}

			return await this.readAndEncode(filePath, mimeType, detail)
		} catch {
			return { type: 'text', text: `[Image unavailable: ${filePath} - read error]` }
		}
	}

	private async resolveViaStore(
		path: string,
		detail: 'auto' | 'low' | 'high' | undefined,
		fileStore: FileStore,
	): Promise<ResolvedImage> {
		const mimeType = getImageMimeType(path)
		if (!mimeType) {
			return { type: 'text', text: `[Image unavailable: ${path} - unsupported format]` }
		}

		// Not `realPath`: the URL comes back from conversation history, and what it
		// names may have become a link out of the store since it was first read.
		const resolved = await fileStore.containedPath(path)
		if (!resolved.ok) {
			return { type: 'text', text: `[Image unavailable: ${path} - ${resolved.error}]` }
		}

		try {
			return await this.readAndEncode(resolved.value, mimeType, detail, fileStore.session)
		} catch {
			return { type: 'text', text: `[Image unavailable: ${path} - read error]` }
		}
	}

	/**
	 * The cached image for this file, and where a new resize of it goes; undefined when the file cannot be read to hash it.
	 * The source is read here so that it is let go before a miss calls the resizer, which reads the file itself.
	 */
	private async lookUpCache(
		filePath: string,
		mimeType: string,
		options: ResizeCacheOptions,
		store: FileStore,
		detail: 'auto' | 'low' | 'high' | undefined,
	): Promise<{ path: string; hit?: ResolvedImage } | undefined> {
		let source: Buffer
		try {
			source = await this.fs.readFile(filePath)
		} catch {
			return undefined
		}
		const path = resizeCachePath(source, mimeType, options)
		const cached = await readCachedResize(store, path)
		const image = cached === UNCHANGED ? { bytes: source, mimeType } : cached
		// An entry over the limits is a miss: the image is resized again and the entry replaced.
		if (image === undefined || image.bytes.length > this.config.maxFileSizeBytes) return { path }
		const encoded = this.encode(filePath, image.bytes, image.mimeType, detail)
		return encoded.type === 'image_url' ? { path, hit: encoded } : { path }
	}

	/**
	 * Resizes the image and encodes it as a data URL. With a session store, a resize is cached there under the hash of
	 * the source and the options, so an image that stays in history is resized once rather than on every turn.
	 */
	private async readAndEncode(
		filePath: string,
		mimeType: string,
		detail: 'auto' | 'low' | 'high' | undefined,
		cacheStore?: FileStore,
	): Promise<ResolvedImage> {
		const options = { maxFileSizeBytes: this.config.maxFileSizeBytes, maxDimension: MAX_IMAGE_DIMENSION }
		const lookup = cacheStore === undefined ? undefined : await this.lookUpCache(filePath, mimeType, options, cacheStore, detail)
		if (lookup?.hit !== undefined) return lookup.hit

		let resized: { path: string; mimeType: string; tempFile?: string } | undefined
		try {
			resized = await this.resizer.resize(filePath, mimeType, options)

			const resultSize = (await this.fs.stat(resized.path)).size
			if (resultSize > this.config.maxFileSizeBytes) {
				return {
					type: 'text',
					text: `[Image unavailable: ${filePath} - file too large (${formatFileSize(resultSize)}, limit ${formatFileSize(this.config.maxFileSizeBytes)})]`,
				}
			}

			const buffer = await this.fs.readFile(resized.path)
			const encoded = this.encode(filePath, buffer, resized.mimeType, detail)
			if (cacheStore !== undefined && lookup !== undefined && encoded.type === 'image_url') {
				if (resized.path !== filePath) {
					await writeCachedResize(cacheStore, lookup.path, { bytes: buffer, mimeType: resized.mimeType })
				} else if (resized.mimeType === mimeType) {
					await writeCachedResize(cacheStore, lookup.path, UNCHANGED)
				}
			}
			return encoded
		} finally {
			if (resized?.tempFile) {
				await this.fs.unlink(resized.tempFile).catch(() => {})
			}
		}
	}

	private encode(filePath: string, buffer: Buffer, mimeType: string, detail: 'auto' | 'low' | 'high' | undefined): ResolvedImage {
		// A resizer that is missing or failed returns the original image.
		const dimensions = readImageDimensions(buffer)
		if (dimensions !== undefined && exceedsMaxDimension(dimensions)) {
			return {
				type: 'text',
				text: `[Image unavailable: ${filePath} - ${dimensions.width}x${dimensions.height} px, over the ${MAX_IMAGE_DIMENSION} px limit, and it could not be downscaled]`,
			}
		}
		return {
			type: 'image_url',
			imageUrl: {
				url: `data:${mimeType};base64,${buffer.toString('base64')}`,
				detail,
			},
		}
	}
}
