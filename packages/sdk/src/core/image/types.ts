import type { FileStore } from '~/core/file-store/types.js'
import type { ToolResultContent } from '~/core/llm/llm-log-types.js'

export interface ImageResizeOptions {
	maxFileSizeBytes?: number
	/** Override the resizer's default max dimension (long side, px). */
	maxDimension?: number
	/** Cancels external image-processing commands. */
	signal?: AbortSignal
}

/**
 * Paths are on the host's `FileSystem`: the caller reads the result through it and unlinks
 * `tempFile` there once the image is encoded. When an image cannot be shrunk, return the original
 * path: the LLM path treats a throw as an unreadable image.
 */
export interface ImageResizer {
	resize(filePath: string, mimeType: string, options?: ImageResizeOptions): Promise<ImageResizeResult>
}

export interface ImageResizeResult {
	path: string
	mimeType: string
	/** A file the resizer created; the caller owns it from here and deletes it. */
	tempFile?: string
}

export interface ImageProcessorConfig {
	maxFileSizeBytes: number
}

export interface ImageProcessor {
	resolveContent(content: ToolResultContent, fileStore?: FileStore): Promise<ToolResultContent>
}
