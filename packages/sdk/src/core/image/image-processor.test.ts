import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
			realPath: (path: string) => Ok(testPath),
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

	it('returns text placeholder when FileStore.realPath fails', async () => {
		const fileStore = {
			realPath: (_path: string) => Err('path outside sandbox'),
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
