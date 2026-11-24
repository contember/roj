import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readImageDimensions } from './dimensions.js'

// Written by libvips from one 37x21 image: width and height differ, so a swap shows.
const FIXTURES = ['37x21.png', '37x21.jpg', '37x21-exif.jpg', '37x21.gif', '37x21-lossy.webp', '37x21-lossless.webp', '37x21-alpha.webp']

describe('readImageDimensions', () => {
	for (const name of FIXTURES) {
		it(`reads ${name}`, () => {
			expect(readImageDimensions(readFileSync(join(import.meta.dir, 'fixtures', name)))).toEqual({ width: 37, height: 21 })
		})
	}

	it('returns undefined for another format and for a header cut short', () => {
		expect(readImageDimensions(Buffer.from('%PDF-1.4'))).toBeUndefined()
		expect(readImageDimensions(readFileSync(join(import.meta.dir, 'fixtures', '37x21.png')).subarray(0, 20))).toBeUndefined()
		expect(readImageDimensions(readFileSync(join(import.meta.dir, 'fixtures', '37x21-exif.jpg')).subarray(0, 100))).toBeUndefined()
	})
})
