export interface ImageDimensions {
	width: number
	height: number
}

/**
 * Longest edge, in pixels, of an image sent to a model. A provider rejects a request with many images once one of
 * them exceeds its many-image limit (3000 px at Anthropic), and the rejection repeats while the image stays in history.
 */
export const MAX_IMAGE_DIMENSION = 2000

export const exceedsMaxDimension = ({ width, height }: ImageDimensions): boolean => Math.max(width, height) > MAX_IMAGE_DIMENSION

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean =>
	bytes.length >= offset + prefix.length && prefix.every((byte, i) => bytes[offset + i] === byte)

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0))

/** Type of a PNG, JPEG, GIF or WebP image, read from its signature. Undefined for any other format. */
export function readImageMimeType(bytes: Uint8Array): 'image/png' | 'image/gif' | 'image/webp' | 'image/jpeg' | undefined {
	if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
	if (startsWith(bytes, ascii('GIF8'))) return 'image/gif'
	if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp'
	if (startsWith(bytes, [0xff, 0xd8])) return 'image/jpeg'
	return undefined
}

/**
 * Pixel size of a PNG, JPEG, GIF or WebP image, read from its header without decoding it.
 * Undefined for any other format or a header cut short.
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	switch (readImageMimeType(bytes)) {
		case 'image/png':
			if (bytes.length < 24) return undefined
			return { width: view.getUint32(16), height: view.getUint32(20) }
		case 'image/gif':
			if (bytes.length < 10) return undefined
			return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
		case 'image/webp':
			return readWebpDimensions(bytes, view)
		case 'image/jpeg':
			return readJpegDimensions(bytes, view)
		case undefined:
			return undefined
	}
}

function readWebpDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
	if (startsWith(bytes, ascii('VP8 '), 12)) {
		if (bytes.length < 30) return undefined
		return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
	}
	if (startsWith(bytes, ascii('VP8L'), 12)) {
		if (bytes.length < 25) return undefined
		const bits = view.getUint32(21, true)
		return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
	}
	if (startsWith(bytes, ascii('VP8X'), 12)) {
		if (bytes.length < 30) return undefined
		const uint24 = (offset: number) => view.getUint16(offset, true) | (view.getUint8(offset + 2) << 16)
		return { width: uint24(24) + 1, height: uint24(27) + 1 }
	}
	return undefined
}

/** Start-of-frame markers carry the size; C4 (Huffman table), C8 (reserved) and CC (arithmetic coding) do not. */
const isStartOfFrame = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

function readJpegDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
	let offset = 2
	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) return undefined
		const marker = bytes[offset + 1]
		// Fill bytes before a marker.
		if (marker === 0xff) {
			offset++
			continue
		}
		// Markers without a length field.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			offset += 2
			continue
		}
		if (isStartOfFrame(marker)) {
			if (offset + 9 > bytes.length) return undefined
			return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
		}
		offset += 2 + view.getUint16(offset + 2)
	}
	return undefined
}
