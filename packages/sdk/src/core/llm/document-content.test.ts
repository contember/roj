import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMMessage } from '~/core/agents/state.js'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import { DefaultImageProcessor } from '~/core/image/image-processor.js'
import { NoopImageResizer } from '~/core/image/noop-resizer.js'
import type { ImageResizer } from '~/core/image/types.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { documentPlaceholder, limitDocumentBytes, resolveDocuments, storeInlineData } from './document-content.js'
import type { ChatMessageContentItem, ResolvedContentItem } from './llm-log-types.js'

const BYTES = Buffer.from('%PDF-1.4\nscanned pages\n')
const DATA = BYTES.toString('base64')
const SHA256 = new Bun.CryptoHasher('sha256').update(BYTES).digest('hex')
const STORED_PATH = `.documents/${SHA256}.pdf`

let dir: string
let files: SessionFileStore

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'roj-document-content-'))
	files = new SessionFileStore(dir, undefined, false, createNodeFileSystem())
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

const inline = (data: string, filename?: string): ChatMessageContentItem =>
	filename === undefined
		? { type: 'document', document: { mediaType: 'application/pdf', data } }
		: { type: 'document', document: { mediaType: 'application/pdf', data, filename } }

describe('storeInlineData', () => {
	test('writes an inline document under the hash of its bytes and keeps a session-relative reference', async () => {
		const stored = await storeInlineData([{ type: 'text', text: 'Read this.' }, inline(DATA, 'scan.pdf')], files)

		expect(stored).toEqual([
			{ type: 'text', text: 'Read this.' },
			{ type: 'document', document: { mediaType: 'application/pdf', path: STORED_PATH, byteLength: BYTES.length, filename: 'scan.pdf' } },
		])
		expect(readFileSync(join(dir, STORED_PATH))).toEqual(BYTES)
	})

	test('does not rewrite a document already stored with its size', async () => {
		mkdirSync(join(dir, '.documents'))
		const existing = Buffer.alloc(BYTES.length, 'x')
		writeFileSync(join(dir, STORED_PATH), existing)

		await storeInlineData([inline(DATA)], files)

		expect(readFileSync(join(dir, STORED_PATH))).toEqual(existing)
	})

	test('rewrites a stored file of the wrong size', async () => {
		mkdirSync(join(dir, '.documents'))
		writeFileSync(join(dir, STORED_PATH), '%PDF-1.4\ncut')

		await storeInlineData([inline(DATA)], files)

		expect(readFileSync(join(dir, STORED_PATH))).toEqual(BYTES)
	})

	test('an empty or non-PDF payload becomes a note and stores nothing', async () => {
		const stored = await storeInlineData([inline('', 'empty.pdf'), inline(Buffer.from('hello').toString('base64'), 'notes.txt')], files)

		expect(stored).toEqual([
			{ type: 'text', text: '[Document unavailable: application/pdf "empty.pdf" - empty file]' },
			{ type: 'text', text: '[Document unavailable: application/pdf "notes.txt" - not a PDF (no %PDF header)]' },
		])
		expect(existsSync(join(dir, '.documents'))).toBe(false)
	})

	test('keeps a reference to a document the agent stored, and refuses any other reference', async () => {
		const stored = await storeInlineData([inline(DATA)], files)
		writeFileSync(join(dir, 'elsewhere.pdf'), BYTES)
		const foreign: ChatMessageContentItem[] = [
			{ type: 'document', document: { mediaType: 'application/pdf', path: 'elsewhere.pdf', byteLength: BYTES.length } },
			{ type: 'document', document: { mediaType: 'application/pdf', path: STORED_PATH, byteLength: BYTES.length + 1 } },
		]

		expect(await storeInlineData(stored, files)).toEqual(stored)
		expect(await storeInlineData(foreign, files)).toEqual([
			{ type: 'text', text: `[Document unavailable: elsewhere.pdf - no stored document of ${BYTES.length} bytes at this path]` },
			{ type: 'text', text: `[Document unavailable: ${STORED_PATH} - no stored document of ${BYTES.length + 1} bytes at this path]` },
		])
		expect(await storeInlineData('plain', files)).toBe('plain')
	})

	test('a document the store cannot write becomes a note, never its bytes', async () => {
		const blocker = join(dir, 'not-a-directory')
		writeFileSync(blocker, 'x')
		const unwritable = new SessionFileStore(join(blocker, 'session'), undefined, false, createNodeFileSystem())

		const stored = await storeInlineData([inline(DATA, 'scan.pdf')], unwritable)

		expect(stored).toEqual([{ type: 'text', text: expect.stringContaining('[Document unavailable: application/pdf "scan.pdf" - ') }])
		expect(JSON.stringify(stored)).not.toContain(DATA)
	})
})

describe('storeInlineData with images', () => {
	const IMAGE_BYTES = Buffer.from('\x89PNG\r\n\x1a\nfake pixels')
	const IMAGE_URL = `data:image/png;base64,${IMAGE_BYTES.toString('base64')}`
	const IMAGE_PATH = `.images/${new Bun.CryptoHasher('sha256').update(IMAGE_BYTES).digest('hex')}.png`
	const resolveImages = (content: ChatMessageContentItem[], store: SessionFileStore) =>
		new DefaultImageProcessor(new NoopImageResizer(), createNodeFileSystem()).resolveContent(content, store)

	test('writes an inline image under the hash of its bytes and keeps a session-relative file:// URL', async () => {
		const stored = await storeInlineData([{ type: 'image_url', imageUrl: { url: IMAGE_URL, detail: 'high' } }], files)

		expect(stored).toEqual([{ type: 'image_url', imageUrl: { url: `file://${IMAGE_PATH}`, detail: 'high' } }])
		expect(readFileSync(join(dir, IMAGE_PATH))).toEqual(IMAGE_BYTES)
	})

	test('the image processor reads a stored image back into the same data URL without resizing it', async () => {
		const resizer: ImageResizer = {
			resize: () => Promise.reject(new Error('a stored image must not be resized')),
		}
		const stored = await storeInlineData([{ type: 'image_url', imageUrl: { url: IMAGE_URL, detail: 'low' } }], files)
		if (typeof stored === 'string') throw new Error('expected content items')

		expect(await new DefaultImageProcessor(resizer, createNodeFileSystem()).resolveContent(stored, files)).toEqual([
			{ type: 'image_url', imageUrl: { url: IMAGE_URL, detail: 'low' } },
		])
	})

	test('the image processor reads a stored image back into the same data URL, plain and sandboxed', async () => {
		for (const store of [files, new SessionFileStore(dir, undefined, true, createNodeFileSystem())]) {
			const stored = await storeInlineData([{ type: 'image_url', imageUrl: { url: IMAGE_URL } }], store)
			expect(stored).toEqual([{ type: 'image_url', imageUrl: { url: `file://${IMAGE_PATH}` } }])
			if (typeof stored === 'string') throw new Error('expected content items')
			expect(await resolveImages(stored, store)).toEqual([{ type: 'image_url', imageUrl: { url: IMAGE_URL } }])
		}
	})

	test('leaves a URL and a file:// path as they are', async () => {
		const content: ChatMessageContentItem[] = [
			{ type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } },
			{ type: 'image_url', imageUrl: { url: 'file:///session/shot.png' } },
		]

		expect(await storeInlineData(content, files)).toEqual(content)
		expect(existsSync(join(dir, '.images'))).toBe(false)
	})

	test('stores a data URL whatever the case of its type, an image/jpg alias or parameters before base64', async () => {
		const payload = IMAGE_BYTES.toString('base64')
		const jpegPath = IMAGE_PATH.replace(/\.png$/, '.jpg')
		const stored = await storeInlineData([
			{ type: 'image_url', imageUrl: { url: `DATA:IMAGE/PNG;BASE64,${payload}` } },
			{ type: 'image_url', imageUrl: { url: `data:image/jpg;base64,${payload}` } },
			{ type: 'image_url', imageUrl: { url: `data:image/jpeg;name=a.jpg;base64,${payload}` } },
		], files)

		expect(stored).toEqual([
			{ type: 'image_url', imageUrl: { url: `file://${IMAGE_PATH}` } },
			{ type: 'image_url', imageUrl: { url: `file://${jpegPath}` } },
			{ type: 'image_url', imageUrl: { url: `file://${jpegPath}` } },
		])
	})

	test('a data URL it cannot store becomes a note, never its payload', async () => {
		const stored = await storeInlineData([
			{ type: 'image_url', imageUrl: { url: 'data:image/svg+xml;base64,PHN2Zy8+' } },
			{ type: 'image_url', imageUrl: { url: 'data:image/png,rawbytes' } },
		], files)

		expect(stored).toEqual([
			{ type: 'text', text: '[Image unavailable: image/svg+xml - unsupported format]' },
			{ type: 'text', text: '[Image unavailable: image/png - not base64-encoded]' },
		])
		expect(existsSync(join(dir, '.images'))).toBe(false)
	})

	test('an empty image or one the store cannot write becomes a note, never its bytes', async () => {
		const blocker = join(dir, 'not-a-directory')
		writeFileSync(blocker, 'x')
		const unwritable = new SessionFileStore(join(blocker, 'session'), undefined, false, createNodeFileSystem())

		expect(await storeInlineData([{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,' } }], files)).toEqual([
			{ type: 'text', text: '[Image unavailable: image/png - empty file]' },
		])
		const stored = await storeInlineData([{ type: 'image_url', imageUrl: { url: IMAGE_URL } }], unwritable)
		expect(stored).toEqual([{ type: 'text', text: expect.stringContaining('[Image unavailable: image/png - ') }])
	})
})

describe('resolveDocuments', () => {
	test('reads a stored document back into base64 every time it is resolved', async () => {
		const stored = await storeInlineData([inline(DATA, 'scan.pdf')], files)

		const expected: ResolvedContentItem[] = [{ type: 'document', document: { mediaType: 'application/pdf', data: DATA, filename: 'scan.pdf' } }]
		expect(await resolveDocuments(stored, files)).toEqual(expected)
		expect(await resolveDocuments(stored, files)).toEqual(expected)
	})

	test('round-trips through a sandboxed store', async () => {
		const sandboxed = new SessionFileStore(dir, undefined, true, createNodeFileSystem())

		const stored = await storeInlineData([inline(DATA)], sandboxed)

		expect(stored).toEqual([{ type: 'document', document: { mediaType: 'application/pdf', path: STORED_PATH, byteLength: BYTES.length } }])
		expect(await resolveDocuments(stored, sandboxed)).toEqual([{ type: 'document', document: { mediaType: 'application/pdf', data: DATA } }])
	})

	test('a stored document that cannot be read becomes a note', async () => {
		const path = '.documents/missing.pdf'
		const content: ChatMessageContentItem[] = [{ type: 'document', document: { mediaType: 'application/pdf', path, byteLength: 3 } }]

		expect(await resolveDocuments(content, files)).toEqual([{ type: 'text', text: `[Document unavailable: ${path} - File not found: ${path}]` }])
		expect(await resolveDocuments(content, undefined)).toEqual([
			{ type: 'text', text: `[Document unavailable: ${path} - no file store to read it from]` },
		])
	})

	test('a path outside the session store is refused', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'roj-document-outside-'))
		const path = join(outside, 'secret.pdf')
		writeFileSync(path, BYTES)

		const resolved = await resolveDocuments([{ type: 'document', document: { mediaType: 'application/pdf', path, byteLength: BYTES.length } }], files)

		rmSync(outside, { recursive: true, force: true })
		expect(resolved).toEqual([{ type: 'text', text: expect.stringContaining(`[Document unavailable: ${path} - `) }])
		expect(JSON.stringify(resolved)).not.toContain(DATA)
	})

	test('keeps inline documents, text and images as they are', async () => {
		const content: ResolvedContentItem[] = [
			{ type: 'text', text: 'Look.' },
			{ type: 'image_url', imageUrl: { url: 'file:///shot.png' } },
			{ type: 'document', document: { mediaType: 'application/pdf', data: DATA } },
		]

		expect(await resolveDocuments(content, files)).toEqual(content)
	})
})

describe('limitDocumentBytes', () => {
	const stored = (name: string, byteLength: number): ChatMessageContentItem => ({
		type: 'document',
		document: { mediaType: 'application/pdf', path: `.documents/${name}.pdf`, byteLength },
	})

	test('keeps the newest documents within the budget and replaces older ones with a note', () => {
		const messages: LLMMessage[] = [
			{ role: 'user', content: [stored('oldest', 40), { type: 'text', text: 'First.' }] },
			{ role: 'assistant', content: 'Noted.' },
			{ role: 'user', content: [stored('older', 50), stored('newest', 50)] },
		]

		expect(limitDocumentBytes(messages, 100)).toEqual([
			{
				role: 'user',
				content: [
					{ type: 'text', text: '[Document omitted: .documents/oldest.pdf, 40 bytes, over the request budget of 100 bytes]' },
					{ type: 'text', text: 'First.' },
				],
			},
			{ role: 'assistant', content: 'Noted.' },
			{ role: 'user', content: [stored('older', 50), stored('newest', 50)] },
		])
	})

	test('counts an inline document by its decoded size', () => {
		const data = Buffer.alloc(30, 1).toString('base64')
		const messages: LLMMessage[] = [{ role: 'user', content: [inline(data, 'a.pdf'), inline(data, 'b.pdf')] }]

		expect(limitDocumentBytes(messages, 50)).toEqual([{
			role: 'user',
			content: [{ type: 'text', text: '[Document omitted: application/pdf "a.pdf", 30 bytes, over the request budget of 50 bytes]' }, inline(data, 'b.pdf')],
		}])
	})

	test('leaves messages within the budget unchanged', () => {
		const messages: LLMMessage[] = [{ role: 'tool', toolCallId: ToolCallId('tc_1'), content: [stored('a', 10)] }, { role: 'user', content: 'Hi.' }]

		expect(limitDocumentBytes(messages, 10)).toEqual(messages)
	})
})

describe('documentPlaceholder', () => {
	test('names the document by its size and the hash of its bytes, the hash that names its stored file', async () => {
		expect(await documentPlaceholder({ mediaType: 'application/pdf', data: DATA, filename: 'scan.pdf' })).toEqual({
			type: 'text',
			text: `[document application/pdf "scan.pdf", ${BYTES.length} bytes, sha256 ${SHA256}; content omitted]`,
		})
	})
})
