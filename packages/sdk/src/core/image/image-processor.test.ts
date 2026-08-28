import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import type { FileStore } from '~/core/file-store/types.js'
import type { ChatMessageContentItem, ToolResultContent } from '~/core/llm/llm-log-types.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { DefaultImageProcessor } from './image-processor.js'
import { NoopImageResizer } from './noop-resizer.js'
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
			return (out as ChatMessageContentItem[])[0]
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

	it('passes maxFileSizeBytes to resizer', async () => {
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
		expect(receivedOptions).toEqual({ maxFileSizeBytes: 999 })

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
