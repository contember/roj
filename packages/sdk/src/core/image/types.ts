import type { FileStore } from '~/core/file-store/types.js'
import type { ToolResultContent } from '~/core/llm/llm-log-types.js'

export interface ImageResizeOptions {
	maxFileSizeBytes?: number
}

export interface ImageResizer {
	resize(filePath: string, mimeType: string, options?: ImageResizeOptions): Promise<ImageResizeResult>
}

export interface ImageResizeResult {
	path: string
	mimeType: string
	tempFile?: string
}

export interface ImageProcessorConfig {
	maxFileSizeBytes: number
}

export interface ImageProcessor {
	resolveContent(content: ToolResultContent, fileStore?: FileStore): Promise<ToolResultContent>
}
