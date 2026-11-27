import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode as encodePng } from 'fast-png'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import type { FileStore } from '~/core/file-store/types.js'
import type { ChatMessageContentItem, ToolResultContent } from '~/core/llm/llm-log-types.js'
import { Err, Ok, type Result } from '~/lib/utils/result.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { readImageDimensions } from './dimensions.js'
import { DefaultImageProcessor } from './image-processor.js'
import { NoopImageResizer } from './noop-resizer.js'
import { IMAGE_CACHE_DIR, readCachedResize, resizeCachePath, writeCachedResize } from './resize-cache.js'
import type { ImageResizer } from './types.js'

describe('DefaultImageProcessor', () => {
	const tempDir = tmpdir()

	function createProcessor(resizer?: ImageResizer, maxFileSizeBytes = 5 * 1024 * 1024) {
		return new DefaultImageProcessor(resizer ?? new NoopImageResizer(), createNodeFileSystem(), { maxFileSizeBytes })
	}

	it('passes through string content unchanged', async () => {
		const processor = createProcessor()
		const result = await processor.resolveContent('hello world')
		expect(result).toBe('hello world')
	})

	it('passes through non-image content items unchanged', async () => {
		const processor = createProcessor()
		const content: ToolResultContent = [
			{ type: 'text', text: 'some text' },
		]
		const result = await processor.resolveContent(content)
		expect(result).toEqual([{ type: 'text', text: 'some text' }])
	})

	it('passes a document through untouched', async () => {
		const processor = createProcessor()
		const content: ToolResultContent = [
			{ type: 'document', document: { mediaType: 'application/pdf', data: 'JVBERi0xLjQK', filename: 'scan.pdf' } },
		]
		const result = await processor.resolveContent(content)
		expect(result).toEqual([{ type: 'document', document: { mediaType: 'application/pdf', data: 'JVBERi0xLjQK', filename: 'scan.pdf' } }])
	})

	it('downscales an inline image over the dimension limit without a resizer', async () => {
		const png = encodePng({ width: 3000, height: 600, data: new Uint8Array(3000 * 600 * 3).fill(90), channels: 3 })
		const processor = createProcessor()

		const result = await processor.resolveContent([{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, detail: 'high' } }])
		if (typeof result === 'string') throw new Error('resolveContent collapsed the array form')
		const item = result[0]
		if (item.type !== 'image_url') throw new Error(`expected an image, got ${JSON.stringify(item)}`)

		expect(item.imageUrl.detail).toBe('high')
		expect(item.imageUrl.url).toStartWith('data:image/jpeg;base64,')
		expect(readImageDimensions(Buffer.from(item.imageUrl.url.slice('data:image/jpeg;base64,'.length), 'base64'))).toEqual({ width: 2000, height: 400 })
	})

	it('says why an inline image over the limit in a format it cannot decode is left out', async () => {
		const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
		// A GIF header that claims 2500×100 px.
		const gif = Buffer.from([...Buffer.from('GIF89a', 'latin1'), 0xc4, 0x09, 0x64, 0x00])
		const processor = createProcessor()

		const result = await processor.resolveContent([{ type: 'image_url', imageUrl: { url: `data:image/gif;base64,${gif.toString('base64')}` } }])

		expect(result).toEqual([{
			type: 'text',
			text: '[Image unavailable: inline image/gif - 2500x100 px, over the 2000 px limit, and it could not be downscaled: image/gif cannot be decoded without libvips]',
		}])
		expect(warnSpy).toHaveBeenCalledTimes(1)
		warnSpy.mockRestore()
	})

	it('passes through non-file:// image URLs unchanged', async () => {
		const processor = createProcessor()
		const content: ToolResultContent = [
			{ type: 'image_url', imageUrl: { url: 'https://example.com/img.png' } },
		]
		const result = await processor.resolveContent(content)
		expect(result).toEqual([{ type: 'image_url', imageUrl: { url: 'https://example.com/img.png' } }])
	})

	it('resolves file:// image to data URL with correct MIME from resizer', async () => {
		// Create a small test file
		const testPath = join(tempDir, `test-processor-${Date.now()}.png`)
		await Bun.write(testPath, Buffer.from('fake-png-data'))

		const resizer: ImageResizer = {
			async resize(filePath, _mimeType, _options) {
				return { path: filePath, mimeType: 'image/jpeg' }
			},
		}

		const processor = createProcessor(resizer)
		const content: ToolResultContent = [
			{ type: 'image_url', imageUrl: { url: `file://${testPath}`, detail: 'auto' } },
		]

		const result = await processor.resolveContent(content)
		const item = (result as ChatMessageContentItem[])[0]

		expect(item.type).toBe('image_url')
		if (item.type === 'image_url') {
			expect(item.imageUrl.url).toStartWith('data:image/jpeg;base64,')
			expect(item.imageUrl.detail).toBe('auto')
		}

		await Bun.file(testPath).exists() && await import('node:fs/promises').then(fs => fs.unlink(testPath).catch(() => {}))
	})

	it('returns text placeholder when file exceeds size limit', async () => {
		const testPath = join(tempDir, `test-large-${Date.now()}.jpg`)
		// Write a file larger than the limit
		await Bun.write(testPath, Buffer.alloc(100))

		const processor = createProcessor(new NoopImageResizer(), 50) // 50 byte limit
		const content: ToolResultContent = [
			{ type: 'image_url', imageUrl: { url: `file://${testPath}` } },
		]

		const result = await processor.resolveContent(content)
		const item = (result as ChatMessageContentItem[])[0]

		expect(item.type).toBe('text')
		if (item.type === 'text') {
			expect(item.text).toContain('file too large')
		}

		await import('node:fs/promises').then(fs => fs.unlink(testPath).catch(() => {}))
	})

	it('returns text placeholder for unsupported format', async () => {
		const testPath = join(tempDir, `test-${Date.now()}.xyz`)
		await Bun.write(testPath, 'some data')

		const processor = createProcessor()
		const content: ToolResultContent = [
			{ type: 'image_url', imageUrl: { url: `file://${testPath}` } },
		]

		const result = await processor.resolveContent(content)
		const item = (result as ChatMessageContentItem[])[0]

		expect(item.type).toBe('text')
		if (item.type === 'text') {
			expect(item.text).toContain('unsupported format')
		}

		await import('node:fs/promises').then(fs => fs.unlink(testPath).catch(() => {}))
	})

	it('returns text placeholder when file not found', async () => {
		const processor = createProcessor()
		const content: ToolResultContent = [
			{ type: 'image_url', imageUrl: { url: 'file:///nonexistent/path/image.png' } },
		]

		const result = await processor.resolveContent(content)
		const item = (result as ChatMessageContentItem[])[0]

		expect(item.type).toBe('text')
		if (item.type === 'text') {
			expect(item.text).toContain('file not found')
		}
	})

	it('resolves via FileStore when provided', async () => {
		const testPath = join(tempDir, `test-store-${Date.now()}.png`)
		await Bun.write(testPath, Buffer.from('fake-png-data'))

		const fileStore = {
			containedPath: async (_path: string) => Ok(testPath),
		} as FileStore

		const processor = createProcessor()
		const content: ToolResultContent = [
			{ type: 'image_url', imageUrl: { url: 'file://workspace/image.png' } },
		]

		const result = await processor.resolveContent(content, fileStore)
		const item = (result as ChatMessageContentItem[])[0]

		expect(item.type).toBe('image_url')
		if (item.type === 'image_url') {
			expect(item.imageUrl.url).toStartWith('data:image/png;base64,')
		}

		await import('node:fs/promises').then(fs => fs.unlink(testPath).catch(() => {}))
	})

	it('returns text placeholder when the store refuses the path', async () => {
		const fileStore = {
			containedPath: async (_path: string) => Err('path outside sandbox'),
		} as FileStore

		const processor = createProcessor()
		const content: ToolResultContent = [
			{ type: 'image_url', imageUrl: { url: 'file://workspace/image.png' } },
		]

		const result = await processor.resolveContent(content, fileStore)
		const item = (result as ChatMessageContentItem[])[0]

		expect(item.type).toBe('text')
		if (item.type === 'text') {
			expect(item.text).toContain('path outside sandbox')
		}
	})

	it('refuses a stored path that has become a link out of the store', async () => {
		// The URL is re-resolved on every later inference, so what it names can be a
		// link now even though it was an ordinary file when the tool first read it.
		const base = await mkdtemp(join(tmpdir(), 'roj-image-containment-'))
		const sessionDir = join(base, 'session')
		const outsideDir = join(base, 'outside')
		await mkdir(sessionDir, { recursive: true })
		await mkdir(outsideDir, { recursive: true })
		await Bun.write(join(outsideDir, 'secret.png'), Buffer.from('outside-bytes'))
		await Bun.write(join(sessionDir, 'own.png'), Buffer.from('own-bytes'))
		await symlink(join(outsideDir, 'secret.png'), join(sessionDir, 'swapped.png'))

		const fileStore = new SessionFileStore(sessionDir, undefined, false, createNodeFileSystem(), 'session')
		const processor = createProcessor()
		const resolve = async (name: string): Promise<ChatMessageContentItem> => {
			const out = await processor.resolveContent([{ type: 'image_url', imageUrl: { url: `file://${name}` } }], fileStore)
			if (typeof out === 'string') throw new Error('resolveContent collapsed the array form')
			return out[0]
		}

		const own = await resolve('own.png')
		expect(own.type).toBe('image_url')

		const swapped = await resolve('swapped.png')
		expect(swapped.type).toBe('text')
		if (swapped.type === 'text') {
			expect(swapped.text).toContain('outside allowed directories')
			expect(swapped.text).not.toContain('outside-bytes')
		}

		await rm(base, { recursive: true, force: true })
	})

	it('passes maxFileSizeBytes and the dimension limit to resizer', async () => {
		const testPath = join(tempDir, `test-opts-${Date.now()}.png`)
		await Bun.write(testPath, Buffer.from('fake-png-data'))

		let receivedOptions: unknown
		const resizer: ImageResizer = {
			async resize(filePath, _mimeType, options) {
				receivedOptions = options
				return { path: filePath, mimeType: 'image/png' }
			},
		}

		const processor = createProcessor(resizer, 999)
		const content: ToolResultContent = [
			{ type: 'image_url', imageUrl: { url: `file://${testPath}` } },
		]

		await processor.resolveContent(content)
		expect(receivedOptions).toEqual({ maxFileSizeBytes: 999, maxDimension: 2000 })

		await import('node:fs/promises').then(fs => fs.unlink(testPath).catch(() => {}))
	})

	it('cleans up temp files from resizer', async () => {
		const testPath = join(tempDir, `test-cleanup-${Date.now()}.png`)
		const tempFile = join(tempDir, `test-temp-${Date.now()}.jpg`)
		await Bun.write(testPath, Buffer.from('fake-png-data'))
		await Bun.write(tempFile, Buffer.from('resized-data'))

		const resizer: ImageResizer = {
			async resize(_filePath, _mimeType, _options) {
				return { path: tempFile, mimeType: 'image/jpeg', tempFile }
			},
		}

		const processor = createProcessor(resizer)
		const content: ToolResultContent = [
			{ type: 'image_url', imageUrl: { url: `file://${testPath}` } },
		]

		await processor.resolveContent(content)

		// Temp file should be cleaned up
		const exists = await Bun.file(tempFile).exists()
		expect(exists).toBe(false)

		await import('node:fs/promises').then(fs => fs.unlink(testPath).catch(() => {}))
	})
})

const fixture = (name: string) => readFile(join(import.meta.dir, 'fixtures', name))

/** A session store whose own reads or writes fail; the image itself is read through the platform fs, so only the cache is hit. */
class FaultyStore extends SessionFileStore {
	constructor(dir: string, private readonly fail: { read?: boolean; write?: 'throw' | 'error' }) {
		super(dir, undefined, false, createNodeFileSystem(), 'session')
	}

	override get session(): SessionFileStore {
		return this
	}

	override async read(path: string): Promise<Result<string, string>>
	override async read(path: string, opts: { type: 'buffer' }): Promise<Result<Buffer, string>>
	override async read(path: string, opts?: { type: 'buffer' }): Promise<Result<string | Buffer, string>> {
		if (this.fail.read) throw new Error('store unavailable')
		return opts ? super.read(path, opts) : super.read(path)
	}

	override async write(path: string, content: string | Buffer): Promise<Result<{ path: string }, string>> {
		if (this.fail.write === 'throw') throw new Error('store unavailable')
		if (this.fail.write === 'error') return Err(`Failed to write: ${path}`)
		return super.write(path, content, { atomic: true })
	}
}

describe('DefaultImageProcessor resize cache', () => {
	let sessionDir: string

	beforeEach(async () => {
		sessionDir = await mkdtemp(join(tmpdir(), 'roj-resize-cache-'))
		await Bun.write(join(sessionDir, 'shot.png'), await fixture('37x21.png'))
	})

	afterEach(async () => {
		await rm(sessionDir, { recursive: true, force: true })
	})

	/** A resizer that turns every image into the JPEG fixture and counts its calls. */
	function countingResizer(): ImageResizer & { calls: number } {
		return {
			calls: 0,
			async resize(_filePath, _mimeType, _options) {
				this.calls++
				const tempFile = join(sessionDir, `resized-${this.calls}.jpg`)
				await Bun.write(tempFile, await fixture('37x21.jpg'))
				return { path: tempFile, mimeType: 'image/jpeg', tempFile }
			},
		}
	}

	const store = (): SessionFileStore => new SessionFileStore(sessionDir, undefined, false, createNodeFileSystem(), 'session')

	async function turn(resizer: ImageResizer, fileStore: FileStore, maxFileSizeBytes = 5 * 1024 * 1024): Promise<ChatMessageContentItem> {
		const processor = new DefaultImageProcessor(resizer, createNodeFileSystem(), { maxFileSizeBytes })
		const out = await processor.resolveContent([{ type: 'image_url', imageUrl: { url: 'file://shot.png' } }], fileStore)
		if (typeof out === 'string') throw new Error('resolveContent collapsed the array form')
		return out[0]
	}

	const resizedUrl = async (): Promise<string> => `data:image/jpeg;base64,${(await fixture('37x21.jpg')).toString('base64')}`

	it('resizes a history image once: a later turn, even in a new processor, reads the cached result', async () => {
		const resizer = countingResizer()

		const first = await turn(resizer, store())
		const second = await turn(resizer, store())

		expect(resizer.calls).toBe(1)
		const expected: ChatMessageContentItem = { type: 'image_url', imageUrl: { url: await resizedUrl(), detail: undefined } }
		expect(first).toEqual(expected)
		expect(second).toEqual(expected)
	})

	it('resizes again when the resize options change', async () => {
		const resizer = countingResizer()

		await turn(resizer, store(), 5 * 1024 * 1024)
		await turn(resizer, store(), 4 * 1024 * 1024)

		expect(resizer.calls).toBe(2)
	})

	// The processor always asks for MAX_IMAGE_DIMENSION, so a changed dimension is shown on the key itself.
	it('keys an entry by the max dimension, so another dimension misses', async () => {
		const source = await fixture('37x21.png')
		const jpeg = { bytes: await fixture('37x21.jpg'), mimeType: 'image/jpeg' }
		await writeCachedResize(store(), resizeCachePath(source, 'image/png', { maxDimension: 2000, maxFileSizeBytes: 1000 }), jpeg)

		expect(await readCachedResize(store(), resizeCachePath(source, 'image/png', { maxDimension: 2000, maxFileSizeBytes: 1000 }))).toEqual(jpeg)
		expect(await readCachedResize(store(), resizeCachePath(source, 'image/png', { maxDimension: 1000, maxFileSizeBytes: 1000 }))).toBeUndefined()
	})

	it('resizes when the cache cannot be read', async () => {
		const resizer = countingResizer()
		await turn(resizer, store())

		const item = await turn(resizer, new FaultyStore(sessionDir, { read: true }))

		expect(resizer.calls).toBe(2)
		expect(item).toEqual({ type: 'image_url', imageUrl: { url: await resizedUrl(), detail: undefined } })
	})

	for (const write of ['throw', 'error'] as const) {
		it(`still sends the image when the cache write fails (${write}), and resizes it again next turn`, async () => {
			const resizer = countingResizer()
			const faulty = new FaultyStore(sessionDir, { write })

			const first = await turn(resizer, faulty)
			await turn(resizer, faulty)

			expect(first).toEqual({ type: 'image_url', imageUrl: { url: await resizedUrl(), detail: undefined } })
			expect(resizer.calls).toBe(2)
		})
	}

	it('replaces an entry that is not an image', async () => {
		const resizer = countingResizer()
		const path = resizeCachePath(await fixture('37x21.png'), 'image/png', { maxDimension: 2000, maxFileSizeBytes: 5 * 1024 * 1024 })
		await Bun.write(join(sessionDir, path), 'not an image')

		const item = await turn(resizer, store())

		expect(resizer.calls).toBe(1)
		expect(item).toEqual({ type: 'image_url', imageUrl: { url: await resizedUrl(), detail: undefined } })
		expect(await readFile(join(sessionDir, path))).toEqual(await fixture('37x21.jpg'))
	})

	it('remembers an image the resizer returned unchanged without keeping a copy of it', async () => {
		let calls = 0
		const passThrough: ImageResizer = {
			async resize(filePath, mimeType) {
				calls++
				return { path: filePath, mimeType }
			},
		}

		const first = await turn(passThrough, store())
		const second = await turn(passThrough, store())

		expect(calls).toBe(1)
		const expected: ChatMessageContentItem = {
			type: 'image_url',
			imageUrl: { url: `data:image/png;base64,${(await fixture('37x21.png')).toString('base64')}`, detail: undefined },
		}
		expect(first).toEqual(expected)
		expect(second).toEqual(expected)
		const entries = await readdir(join(sessionDir, IMAGE_CACHE_DIR))
		expect(entries).toHaveLength(1)
		expect(await readFile(join(sessionDir, IMAGE_CACHE_DIR, entries[0]))).toHaveLength(0)
	})
})
