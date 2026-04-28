import type { ImageResizeOptions, ImageResizer, ImageResizeResult } from './types.js'

export class NoopImageResizer implements ImageResizer {
	async resize(filePath: string, mimeType: string, _options?: ImageResizeOptions): Promise<ImageResizeResult> {
		return { path: filePath, mimeType }
	}
}
