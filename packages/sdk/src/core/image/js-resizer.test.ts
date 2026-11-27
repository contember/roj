import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { encode as encodePng } from 'fast-png'
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { readImageDimensions } from './dimensions.js'
import { downscaleImage, JsImageResizer, readJpegOrientation } from './js-resizer.js'

type Color = readonly [number, number, number]
const RED: Color = [220, 30, 30]
const GREEN: Color = [30, 220, 30]
const BLUE: Color = [30, 30, 220]
const WHITE: Color = [255, 255, 255]
const BUDGET = { maxDecodeBytes: 1024 * 1024 * 1024 }

/** A PNG built chunk by chunk, for the pixel formats the encoder does not write. */
function rawPng(width: number, height: number, depth: number, colorType: number, rows: Uint8Array[], extra: Buffer[] = []): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
		const length = Buffer.alloc(4)
		length.writeUInt32BE(data.length)
		const checksum = Buffer.alloc(4)
		checksum.writeUInt32BE(crc32(typed))
		return Buffer.concat([length, typed, checksum])
	}
	const header = Buffer.alloc(13)
	header.writeUInt32BE(width, 0)
	header.writeUInt32BE(height, 4)
	header[8] = depth
	header[9] = colorType
	const scanlines = Buffer.concat(rows.map(row => Buffer.concat([Buffer.from([0]), row])))
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		...extra.map(data => chunk(data.subarray(0, 4).toString('latin1'), data.subarray(4))),
		chunk('IDAT', deflateSync(scanlines)),
		chunk('IEND', Buffer.alloc(0)),
	])
}

/** RGBA pixels in four quadrants: red top left, green top right, blue bottom left, white bottom right. */
function quadrants(width: number, height: number): Uint8Array {
	const data = new Uint8Array(width * height * 4)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const color = y < height / 2 ? (x < width / 2 ? RED : GREEN) : (x < width / 2 ? BLUE : WHITE)
			data.set([...color, 255], (y * width + x) * 4)
		}
	}
	return data
}

/** RGBA pixels, left half `left` and right half `right`. */
function halves(width: number, height: number, left: Color, right: Color): Uint8Array {
	const data = new Uint8Array(width * height * 4)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			data.set([...(x < width / 2 ? left : right), 255], (y * width + x) * 4)
		}
	}
	return data
}

function jpeg(width: number, height: number, left: Color = RED, right: Color = BLUE): Buffer {
	return encodeJpeg({ width, height, data: halves(width, height, left, right) }, 95).data
}

/** The JPEG with an EXIF segment that says how it is displayed. */
function withOrientation(image: Buffer, orientation: number): Buffer {
	const tiff = Buffer.alloc(26)
	tiff.write('II*\0', 0, 'latin1')
	tiff.writeUInt32LE(8, 4)
	tiff.writeUInt16LE(1, 8)
	tiff.writeUInt16LE(0x0112, 10)
	tiff.writeUInt16LE(3, 12)
	tiff.writeUInt32LE(1, 14)
	tiff.writeUInt16LE(orientation, 18)
	const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
	const header = Buffer.from([0xff, 0xe1, 0, 0])
	header.writeUInt16BE(exif.length + 2, 2)
	return Buffer.concat([image.subarray(0, 2), header, exif, image.subarray(2)])
}

function decoded(bytes: Uint8Array) {
	return decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true })
}

function pixel(image: ReturnType<typeof decoded>, x: number, y: number): number[] {
	const i = (y * image.width + x) * 4
	return Array.from(image.data.subarray(i, i + 3))
}

function expectColor(actual: number[], expected: Color) {
	actual.forEach((value, i) => expect(Math.abs(value - expected[i])).toBeLessThan(12))
}

describe('downscaleImage', () => {
	it('shrinks a JPEG to the max dimension on its long edge and keeps its colours', () => {
		const result = decoded(downscaleImage(jpeg(3000, 1200), { maxDimension: 2000, ...BUDGET }))

		expect([result.width, result.height]).toEqual([2000, 800])
		expectColor(pixel(result, 100, 400), RED)
		expectColor(pixel(result, 1900, 400), BLUE)
	})

	it('shrinks an RGBA PNG, flattening transparency onto white', () => {
		const width = 2400
		const height = 600
		const data = halves(width, height, RED, BLUE)
		// The right half is fully transparent.
		for (let i = 0; i < width * height; i++) if (i % width >= width / 2) data[i * 4 + 3] = 0
		const result = decoded(downscaleImage(encodePng({ width, height, data, channels: 4 }), { maxDimension: 1200, ...BUDGET }))

		expect([result.width, result.height]).toEqual([1200, 300])
		expectColor(pixel(result, 100, 150), RED)
		expectColor(pixel(result, 1100, 150), [255, 255, 255])
	})

	it('reads 16-bit and grayscale PNGs', () => {
		const rgb16 = new Uint16Array(30 * 10 * 3).fill(65535)
		const white = decoded(downscaleImage(encodePng({ width: 30, height: 10, data: rgb16, channels: 3, depth: 16 }), { maxDimension: 15, ...BUDGET }))
		expect([white.width, white.height]).toEqual([15, 5])
		expectColor(pixel(white, 7, 2), [255, 255, 255])

		const gray = new Uint8Array(30 * 10).fill(128)
		const result = decoded(downscaleImage(encodePng({ width: 30, height: 10, data: gray, channels: 1 }), { maxDimension: 15, ...BUDGET }))
		expectColor(pixel(result, 7, 2), [128, 128, 128])
	})

	// Stored 400×200; what the displayed image shows at its top-left and top-right corners.
	const orientations: Array<[number, Color, Color]> = [
		[1, RED, GREEN],
		[2, GREEN, RED],
		[3, WHITE, BLUE],
		[4, BLUE, WHITE],
		[5, RED, BLUE],
		[6, BLUE, RED],
		[7, WHITE, GREEN],
		[8, GREEN, WHITE],
	]
	for (const [orientation, topLeft, topRight] of orientations) {
		it(`turns the image the way EXIF orientation ${orientation} displays it`, () => {
			const image = withOrientation(encodeJpeg({ width: 400, height: 200, data: quadrants(400, 200) }, 95).data, orientation)
			expect(readJpegOrientation(image)).toBe(orientation)

			const result = decoded(downscaleImage(image, { maxDimension: 200, ...BUDGET }))

			expect([result.width, result.height]).toEqual(orientation >= 5 ? [100, 200] : [200, 100])
			expectColor(pixel(result, 5, 5), topLeft)
			expectColor(pixel(result, result.width - 5, 5), topRight)
		})
	}

	it('reads palette PNGs, with transparency, and gray packed below a byte', () => {
		// Two palette entries: opaque red, and blue made fully transparent by tRNS; left half index 0, right half 1.
		const plte = Buffer.concat([Buffer.from('PLTE', 'latin1'), Buffer.from([220, 30, 30, 30, 30, 220])])
		const trns = Buffer.concat([Buffer.from('tRNS', 'latin1'), Buffer.from([255, 0])])
		const indexed = rawPng(16, 4, 8, 3, Array.from({ length: 4 }, () => Uint8Array.from({ length: 16 }, (_, x) => (x < 8 ? 0 : 1))), [plte, trns])
		const fromPalette = decoded(downscaleImage(indexed, { maxDimension: 8, ...BUDGET }))
		expectColor(pixel(fromPalette, 1, 1), RED)
		expectColor(pixel(fromPalette, 6, 1), WHITE)

		// 1-bit gray: the left byte of each row black, the right byte white.
		const bits = rawPng(16, 4, 1, 0, Array.from({ length: 4 }, () => Uint8Array.from([0x00, 0xff])))
		const fromBits = decoded(downscaleImage(bits, { maxDimension: 8, ...BUDGET }))
		expectColor(pixel(fromBits, 1, 1), [0, 0, 0])
		expectColor(pixel(fromBits, 6, 1), WHITE)
	})

	it('estimates the decode cost from the header: a 16-bit RGBA PNG costs more than an 8-bit RGB one', () => {
		const budget = { maxDimension: 500, maxDecodeBytes: 20 * 1024 * 1024 }
		const rgb8 = encodePng({ width: 1000, height: 1000, data: new Uint8Array(1000 * 1000 * 3), channels: 3 })
		const rgba16 = encodePng({ width: 1000, height: 1000, data: new Uint16Array(1000 * 1000 * 4), channels: 4, depth: 16 })

		expect(readImageDimensions(downscaleImage(rgb8, budget))).toEqual({ width: 500, height: 500 })
		expect(() => downscaleImage(rgba16, budget)).toThrow('a 1000x1000 px image/png takes ~27 MB to decode, over the 20 MB this host allows without libvips')
	})

	it('refuses, before decoding, an image over the decode budget', () => {
		expect(() => downscaleImage(jpeg(3000, 1000), { maxDimension: 2000, maxDecodeBytes: 64 * 1024 * 1024 })).toThrow(
			'a 3000x1000 px image/jpeg takes ~172 MB to decode, over the 64 MB this host allows without libvips',
		)
	})

	it('lowers quality, then the dimension, until the image fits the size limit', () => {
		const width = 1000
		const height = 1000
		const noise = new Uint8Array(width * height * 4)
		for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24
		const source = encodeJpeg({ width, height, data: noise }, 100).data
		const unlimited = downscaleImage(source, { maxDimension: 1000, ...BUDGET })
		const limit = Math.floor(unlimited.length / 4)

		const result = downscaleImage(source, { maxDimension: 1000, maxFileSizeBytes: limit, ...BUDGET })

		expect(result.length).toBeLessThanOrEqual(limit)
		expect(readImageDimensions(result)).toBeDefined()
	})

	it('throws for a format it cannot decode', async () => {
		const gif = await readFile(join(import.meta.dir, 'fixtures', '37x21.gif'))
		expect(() => downscaleImage(gif, { maxDimension: 10, ...BUDGET })).toThrow('image/gif cannot be decoded without libvips')
	})
})

describe('JsImageResizer', () => {
	const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
	const dirs: string[] = []
	afterAll(() => warnSpy.mockRestore())
	afterEach(async () => {
		warnSpy.mockClear()
		for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
	})

	async function setup() {
		const dir = await mkdtemp(join(tmpdir(), 'roj-js-resizer-'))
		dirs.push(dir)
		const resizer = new JsImageResizer({ fs: createNodeFileSystem(), tmpDir: dir })
		return { dir, resizer }
	}

	it('writes a downscaled JPEG to a temp file the caller owns', async () => {
		const { dir, resizer } = await setup()
		const source = join(dir, 'big.png')
		await writeFile(source, encodePng({ width: 2500, height: 100, data: halves(2500, 100, RED, BLUE), channels: 4 }))

		const result = await resizer.resize(source, 'image/png', { maxDimension: 2000, maxFileSizeBytes: 5 * 1024 * 1024 })

		expect(result.mimeType).toBe('image/jpeg')
		expect(result.tempFile).toBe(result.path)
		expect(readImageDimensions(await readFile(result.path))).toEqual({ width: 2000, height: 80 })
	})

	it('returns an image within the limits as it is', async () => {
		const { dir, resizer } = await setup()
		const source = join(dir, 'small.jpg')
		await writeFile(source, jpeg(100, 50))

		expect(await resizer.resize(source, 'image/jpeg', { maxDimension: 2000, maxFileSizeBytes: 1024 * 1024 })).toEqual({ path: source, mimeType: 'image/jpeg' })
	})

	it('returns the original and warns when it cannot decode the image', async () => {
		const { dir, resizer } = await setup()
		const source = join(dir, 'big.gif')
		const gif = Buffer.from(await readFile(join(import.meta.dir, 'fixtures', '37x21.gif')))
		await writeFile(source, gif)

		expect(await resizer.resize(source, 'image/gif', { maxDimension: 10 })).toEqual({
			path: source,
			mimeType: 'image/gif',
			failure: 'image/gif cannot be decoded without libvips',
		})
		expect(warnSpy).toHaveBeenCalledTimes(1)
		expect(await readdir(dir)).toEqual(['big.gif'])
	})

	it('throws when aborted', async () => {
		const { dir, resizer } = await setup()
		const source = join(dir, 'big.jpg')
		await writeFile(source, jpeg(2500, 100))
		const controller = new AbortController()
		controller.abort()

		await expect(resizer.resize(source, 'image/jpeg', { maxDimension: 2000, signal: controller.signal })).rejects.toThrow()
	})
})
