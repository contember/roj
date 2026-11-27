import { join } from 'node:path'
import { convertIndexedToRgb, type DecodedPng, decode as decodePng } from 'fast-png'
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js'
import type { FileSystem } from '~/platform/fs.js'
import { MAX_IMAGE_DIMENSION, readImageDimensions, readImageMimeType } from './dimensions.js'
import type { ImageResizeOptions, ImageResizer, ImageResizeResult } from './types.js'

/**
 * Pixels as decoded: 1 channel is gray, 2 gray and alpha, 3 RGB, 4 RGBA; every sample runs from 0 to `max`.
 */
interface Raster {
	width: number
	height: number
	channels: number
	max: number
	data: ArrayLike<number>
}

/** RGBA, 8 bits per sample: what the JPEG encoder takes. */
interface Rgba {
	width: number
	height: number
	data: Uint8Array
}

/** The steps VipsImageResizer takes to fit the size limit: lower quality first, then half the dimension. */
const ATTEMPTS = [
	{ scale: 1, quality: 85 },
	{ scale: 1, quality: 70 },
	{ scale: 1, quality: 50 },
	{ scale: 1, quality: 30 },
	{ scale: 0.5, quality: 70 },
	{ scale: 0.5, quality: 50 },
	{ scale: 0.5, quality: 30 },
]

export interface DownscaleOptions {
	maxDimension: number
	maxFileSizeBytes?: number
}

/**
 * Re-encodes a JPEG or PNG as a JPEG whose long edge fits `maxDimension`, at the highest quality that fits
 * `maxFileSizeBytes`, or the most compressed attempt when none does. Throws for any other format.
 * Pure JS rather than wasm: the isolate loader takes text modules only.
 */
export function downscaleImage(bytes: Uint8Array, options: DownscaleOptions): Buffer {
	const mimeType = readImageMimeType(bytes)
	const raster = mimeType === 'image/jpeg'
		? decodeJpegRaster(bytes)
		: mimeType === 'image/png'
		? decodePngRaster(bytes)
		: undefined
	if (raster === undefined) throw new Error(`${mimeType ?? 'this format'} cannot be decoded without libvips`)
	const orientation = mimeType === 'image/jpeg' ? readJpegOrientation(bytes) : 1

	const shrunk = new Map<number, Rgba>()
	let encoded: Buffer | undefined
	for (const { scale, quality } of ATTEMPTS) {
		const dimension = Math.max(1, Math.floor(options.maxDimension * scale))
		let pixels = shrunk.get(dimension)
		if (pixels === undefined) {
			pixels = orient(shrink(raster, dimension), orientation)
			shrunk.set(dimension, pixels)
		}
		encoded = encodeJpeg(pixels, quality).data
		if (options.maxFileSizeBytes === undefined || encoded.length <= options.maxFileSizeBytes) return encoded
	}
	if (encoded === undefined) throw new Error('Image compression produced no result')
	return encoded
}

function decodeJpegRaster(bytes: Uint8Array): Raster {
	const decoded = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true })
	return { width: decoded.width, height: decoded.height, channels: 4, max: 255, data: decoded.data }
}

function decodePngRaster(bytes: Uint8Array): Raster {
	const png = decodePng(bytes)
	const pixelCount = png.width * png.height
	if (png.palette !== undefined) {
		const data = convertIndexedToRgb(png)
		return { width: png.width, height: png.height, channels: data.length / pixelCount, max: 255, data }
	}
	if (png.depth < 8) {
		// Gray packed below a byte: a palette of its levels unpacks it.
		const levels = 2 ** png.depth
		const palette = Array.from({ length: levels }, (_, level) => {
			const value = Math.round(level * 255 / (levels - 1))
			return [value, value, value]
		})
		const unpacked: DecodedPng = { ...png, palette }
		return { width: png.width, height: png.height, channels: 3, max: 255, data: convertIndexedToRgb(unpacked) }
	}
	return { width: png.width, height: png.height, channels: png.channels, max: 2 ** png.depth - 1, data: png.data }
}

/** Box filter to fit `dimension` on the long edge, only ever shrinking; alpha is flattened onto white. */
function shrink(raster: Raster, dimension: number): Rgba {
	const { width, height } = raster
	const scale = Math.min(1, dimension / Math.max(width, height))
	const targetWidth = Math.max(1, Math.round(width * scale))
	const targetHeight = Math.max(1, Math.round(height * scale))
	return shrinkColumns(shrinkRows(raster, targetWidth), height, targetWidth, targetHeight)
}

/** Averages each row down to `targetWidth` RGB pixels. */
function shrinkRows(raster: Raster, targetWidth: number): Float32Array {
	const { width, height, channels, max, data } = raster
	const gray = channels <= 2
	const alphaOffset = channels === 2 || channels === 4 ? channels - 1 : -1
	const toByte = 255 / max
	const out = new Float32Array(targetWidth * height * 3)
	for (let y = 0; y < height; y++) {
		for (let tx = 0; tx < targetWidth; tx++) {
			const x0 = Math.floor(tx * width / targetWidth)
			const x1 = Math.max(x0 + 1, Math.floor((tx + 1) * width / targetWidth))
			let r = 0
			let g = 0
			let b = 0
			for (let x = x0; x < x1; x++) {
				const i = (y * width + x) * channels
				const alpha = alphaOffset < 0 ? 1 : data[i + alphaOffset] / max
				const background = 255 * (1 - alpha)
				const red = data[i] * toByte * alpha + background
				r += red
				g += gray ? red : data[i + 1] * toByte * alpha + background
				b += gray ? red : data[i + 2] * toByte * alpha + background
			}
			const count = x1 - x0
			const o = (y * targetWidth + tx) * 3
			out[o] = r / count
			out[o + 1] = g / count
			out[o + 2] = b / count
		}
	}
	return out
}

/** Averages each column of RGB rows down to `targetHeight`, as RGBA bytes. */
function shrinkColumns(rows: Float32Array, height: number, width: number, targetHeight: number): Rgba {
	const data = new Uint8Array(width * targetHeight * 4)
	for (let ty = 0; ty < targetHeight; ty++) {
		const y0 = Math.floor(ty * height / targetHeight)
		const y1 = Math.max(y0 + 1, Math.floor((ty + 1) * height / targetHeight))
		const count = y1 - y0
		for (let x = 0; x < width; x++) {
			let r = 0
			let g = 0
			let b = 0
			for (let y = y0; y < y1; y++) {
				const i = (y * width + x) * 3
				r += rows[i]
				g += rows[i + 1]
				b += rows[i + 2]
			}
			const o = (ty * width + x) * 4
			data[o] = Math.round(r / count)
			data[o + 1] = Math.round(g / count)
			data[o + 2] = Math.round(b / count)
			data[o + 3] = 255
		}
	}
	return { width, height: targetHeight, data }
}

/** The EXIF orientation of a JPEG, 1 to 8; 1 (as stored) when it has none or it cannot be read. */
export function readJpegOrientation(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	try {
		let offset = 2
		while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
			const marker = bytes[offset + 1]
			if (marker === 0xff) {
				offset++
				continue
			}
			// Start of scan: the metadata segments are all before it.
			if (marker === 0xda) return 1
			const length = view.getUint16(offset + 2)
			if (marker === 0xe1 && view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0) {
				const tiff = offset + 10
				const little = view.getUint16(tiff) === 0x4949
				const ifd = tiff + view.getUint32(tiff + 4, little)
				const entries = view.getUint16(ifd, little)
				for (let entry = 0; entry < entries; entry++) {
					const at = ifd + 2 + entry * 12
					if (view.getUint16(at, little) !== 0x0112) continue
					const orientation = view.getUint16(at + 8, little)
					return orientation >= 1 && orientation <= 8 ? orientation : 1
				}
				return 1
			}
			offset += 2 + length
		}
	} catch (error) {
		if (!(error instanceof RangeError)) throw error
	}
	return 1
}

/** Turns stored pixels the way the EXIF orientation says they are displayed, as vipsthumbnail does. */
function orient(image: Rgba, orientation: number): Rgba {
	if (orientation === 1) return image
	const { width: w, height: h } = image
	const swap = orientation >= 5
	const width = swap ? h : w
	const height = swap ? w : h
	const data = new Uint8Array(image.data.length)
	for (let dy = 0; dy < height; dy++) {
		for (let dx = 0; dx < width; dx++) {
			const [sx, sy] = sourceOf(orientation, dx, dy, w, h)
			data.set(image.data.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (dy * width + dx) * 4)
		}
	}
	return { width, height, data }
}

/** Where the displayed pixel (dx, dy) is stored in a `w` × `h` image. */
function sourceOf(orientation: number, dx: number, dy: number, w: number, h: number): [number, number] {
	switch (orientation) {
		case 2:
			return [w - 1 - dx, dy]
		case 3:
			return [w - 1 - dx, h - 1 - dy]
		case 4:
			return [dx, h - 1 - dy]
		case 5:
			return [dy, dx]
		case 6:
			return [dy, h - 1 - dx]
		case 7:
			return [w - 1 - dy, h - 1 - dx]
		case 8:
			return [w - 1 - dy, dx]
		default:
			return [dx, dy]
	}
}

export interface JsImageResizerOptions {
	fs: FileSystem
	tmpDir: string
	maxDimension?: number
}

/**
 * Shrinks JPEG and PNG images in JS, for hosts without the libvips binaries. Slower than vips and limited to those
 * two formats; any other image comes back as it was, per the ImageResizer contract.
 */
export class JsImageResizer implements ImageResizer {
	private readonly fs: FileSystem
	private readonly tmpDir: string
	private readonly maxDimension: number

	constructor(options: JsImageResizerOptions) {
		this.fs = options.fs
		this.tmpDir = options.tmpDir
		this.maxDimension = options.maxDimension ?? MAX_IMAGE_DIMENSION
	}

	async resize(filePath: string, mimeType: string, options?: ImageResizeOptions): Promise<ImageResizeResult> {
		const maxDimension = options?.maxDimension ?? this.maxDimension
		const maxFileSizeBytes = options?.maxFileSizeBytes
		const signal = options?.signal
		let outputPath: string | undefined
		try {
			signal?.throwIfAborted()
			const source = await this.fs.readFile(filePath)
			const dimensions = readImageDimensions(source)
			const fitsDimension = dimensions !== undefined && Math.max(dimensions.width, dimensions.height) <= maxDimension
			if (fitsDimension && (maxFileSizeBytes === undefined || source.length <= maxFileSizeBytes)) return { path: filePath, mimeType }

			const bytes = downscaleImage(source, { maxDimension, maxFileSizeBytes })
			signal?.throwIfAborted()
			outputPath = join(this.tmpDir, `roj-resize-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`)
			await this.fs.writeFile(outputPath, bytes)
			signal?.throwIfAborted()
			return { path: outputPath, mimeType: 'image/jpeg', tempFile: outputPath }
		} catch (error) {
			if (outputPath !== undefined) await this.fs.unlink(outputPath).catch(() => {})
			if (signal?.aborted) signal.throwIfAborted()
			console.warn(`[image-resize] could not resize ${filePath} without libvips, using the original image:`, error instanceof Error ? error.message : error)
			return { path: filePath, mimeType }
		}
	}
}
