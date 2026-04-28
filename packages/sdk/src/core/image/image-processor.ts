import { resolve } from 'node:path'
import type { FileStore } from '~/core/file-store/types.js'
import type { ChatMessageContentItem, ToolResultContent } from '~/core/llm/llm-log-types.js'
import { getImageMimeType } from '~/lib/mime.js'
import type { FileSystem } from '~/platform/fs.js'
import type { ImageProcessor, ImageProcessorConfig, ImageResizer } from './types.js'

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
				if (!item.imageUrl.url.startsWith('file://')) return item

				const rawPath = item.imageUrl.url.slice(7)

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

	private async resolveDirect(
		rawPath: string,
		detail: 'auto' | 'low' | 'high' | undefined,
	): Promise<ChatMessageContentItem> {
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
	): Promise<ChatMessageContentItem> {
		const mimeType = getImageMimeType(path)
		if (!mimeType) {
			return { type: 'text', text: `[Image unavailable: ${path} - unsupported format]` }
		}

		const resolved = fileStore.realPath(path)
		if (!resolved.ok) {
			return { type: 'text', text: `[Image unavailable: ${path} - ${resolved.error}]` }
		}

		try {
			return await this.readAndEncode(resolved.value, mimeType, detail)
		} catch {
			return { type: 'text', text: `[Image unavailable: ${path} - read error]` }
		}
	}

	private async readAndEncode(
		filePath: string,
		mimeType: string,
		detail: 'auto' | 'low' | 'high' | undefined,
	): Promise<ChatMessageContentItem> {
		let resized: { path: string; mimeType: string; tempFile?: string } | undefined
		try {
			resized = await this.resizer.resize(filePath, mimeType, { maxFileSizeBytes: this.config.maxFileSizeBytes })

			const resultSize = (await this.fs.stat(resized.path)).size
			if (resultSize > this.config.maxFileSizeBytes) {
				return {
					type: 'text',
					text: `[Image unavailable: ${filePath} - file too large (${formatFileSize(resultSize)}, limit ${formatFileSize(this.config.maxFileSizeBytes)})]`,
				}
			}

			const buffer = await this.fs.readFile(resized.path)
			const base64 = buffer.toString('base64')
			return {
				type: 'image_url',
				imageUrl: {
					url: `data:${resized.mimeType};base64,${base64}`,
					detail,
				},
			}
		} finally {
			if (resized?.tempFile) {
				await this.fs.unlink(resized.tempFile).catch(() => {})
			}
		}
	}
}
