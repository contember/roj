/**
 * MIME type detection utilities.
 */

const IMAGE_MIME_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
}

/**
 * Get MIME type for an image file based on extension.
 * Returns undefined if not a recognized image format.
 */
export function getImageMimeType(filename: string): string | undefined {
	const ext = filename.split('.').pop()?.toLowerCase()
	return ext ? IMAGE_MIME_TYPES[ext] : undefined
}
