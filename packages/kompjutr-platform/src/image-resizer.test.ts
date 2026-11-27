import { afterAll, expect, spyOn, test } from 'bun:test'
import { crc32, deflateSync } from 'node:zlib'
import { Workspace } from '@kompjutr/do'
import { createKompjutrPlatform } from './index.js'
import { BunSqliteStorage } from './testing/storage.js'

const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
afterAll(() => warnSpy.mockRestore())

function platform() {
	const workspace = new Workspace({ storage: new BunSqliteStorage() })
	workspace.filesystem.mkdir('/images', { recursive: true })
	return createKompjutrPlatform(workspace)
}

/** A gray 8-bit PNG, every pixel `value`. */
function grayPng(width: number, height: number, value: number): Buffer {
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
	header[8] = 8
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, value)])
	const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))])
}

/** Only the start of a 3-component JPEG, up to its frame header: enough to be sized, not to be decoded. */
function jpegHeader(width: number, height: number): Buffer {
	const frame = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
	frame.writeUInt16BE(height, 5)
	frame.writeUInt16BE(width, 7)
	return Buffer.concat([Buffer.from([0xff, 0xd8]), frame])
}

test('shrinks an image within the isolate decode budget without a process table', async () => {
	const { fs, imageResizer } = platform()
	await fs.writeFile('/images/wide.png', grayPng(2400, 100, 128))

	const result = await imageResizer?.resize('/images/wide.png', 'image/png', { maxDimension: 2000 })

	expect(result?.mimeType).toBe('image/jpeg')
	expect(result?.tempFile).toBe(result?.path)
})

test('refuses, before decoding, a photo whose decoding would not fit the isolate', async () => {
	const { fs, imageResizer } = platform()
	await fs.writeFile('/images/photo.jpg', jpegHeader(2001, 1200))

	expect(await imageResizer?.resize('/images/photo.jpg', 'image/jpeg', { maxDimension: 2000 })).toEqual({
		path: '/images/photo.jpg',
		mimeType: 'image/jpeg',
		failure: 'a 2001x1200 px image/jpeg takes ~137 MB to decode, over the 48 MB this host allows without libvips',
	})
})
