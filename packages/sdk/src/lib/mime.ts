/**
 * MIME type detection utilities.
 */

// Only formats accepted as image content by the LLM providers (Anthropic
// allows jpeg/png/gif/webp). Notably excludes svg/bmp/ico: feeding those as
// image blocks makes the provider reject the whole request with a 400
// ("media_type: Input should be 'image/jpeg', 'image/png', 'image/gif' or
// 'image/webp'"). Such files fall through to being read as text instead —
// which for SVG (XML) is more useful to the model anyway.
const IMAGE_MIME_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
}

/**
 * Get MIME type for an image file based on extension.
 * Returns undefined if not an LLM-supported image format.
 */
export function getImageMimeType(filename: string): string | undefined {
	const ext = filename.split('.').pop()?.toLowerCase()
	return ext ? IMAGE_MIME_TYPES[ext] : undefined
}
