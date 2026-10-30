import type { LLMMessage } from '~/core/agents/state.js'
import type { FileStore } from '~/core/file-store/types.js'
import type {
	ChatMessageContentItem,
	ChatMessageContentItemDocument,
	ChatMessageContentItemImage,
	ChatMessageContentItemText,
	InlineDocument,
	ResolvedContentItem,
	StoredDocument,
	ToolResultContent,
} from './llm-log-types.js'

/** Session-store directory that keeps the documents an agent's history refers to; a fork copies it. */
export const DOCUMENTS_DIR = '.documents'

const STORED_DOCUMENT_PATH = /^\.documents\/[0-9a-f]{64}\.pdf$/

/** Session-store directory that keeps the images an agent's history refers to; a fork copies it. */
export const IMAGES_DIR = '.images'

/** The `file://` path of an image an agent stored: session-relative, so a fork resolves it in its own store. */
export const STORED_IMAGE_PATH = /^\.images\/[0-9a-f]{64}\.(?:png|jpg|gif|webp)$/

/** A `data:` URL's media type and parameters (`;base64` among them), up to the comma its payload follows. */
const DATA_URL = /^data:([^;,]*)((?:;[^;,]*)*),/i

/** The stored file's extension for each image type the providers take. */
const IMAGE_FORMATS: ReadonlyMap<string, string> = new Map([
	['image/png', 'png'],
	['image/jpeg', 'jpg'],
	['image/jpg', 'jpg'],
	['image/gif', 'gif'],
	['image/webp', 'webp'],
])

/**
 * Most document bytes one request reads back and sends. A request holds each document about four times
 * at its peak (the bytes, their base64, the JSON body and the copy the HTTP client sends), so 16 MB keeps
 * the documents near 64 MB, leaving half of a 128 MB isolate for the rest of the session. Its base64,
 * ~21 MB, also stays under the 32 MB request limit of the providers' PDF APIs.
 */
export const MAX_REQUEST_DOCUMENT_BYTES = 16 * 1024 * 1024

/** Decoded size of a base64 payload, without decoding it. */
export function base64ByteLength(data: string): number {
	const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
	return Math.floor(data.length * 3 / 4) - padding
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const describeDocument = ({ mediaType, filename }: InlineDocument | StoredDocument): string =>
	filename === undefined ? mediaType : `${mediaType} "${filename}"`

/**
 * What a persisted request keeps of an inline document: its size and the SHA-256 of its bytes, the
 * same hash that names it in the session store, while the base64 would otherwise dominate every log
 * entry and snapshot. Base64 decoding skips invalid characters, so a malformed payload cannot make it throw.
 */
export async function documentPlaceholder(document: InlineDocument): Promise<ChatMessageContentItemText> {
	const bytes = Buffer.from(document.data, 'base64')
	return {
		type: 'text',
		text: `[document ${describeDocument(document)}, ${bytes.length} bytes, sha256 ${await sha256Hex(bytes)}; content omitted]`,
	}
}

/** Content with every inline document replaced by its placeholder; a stored document is already small and is kept. */
export async function omitDocumentData(content: string | ChatMessageContentItem[]): Promise<string | ChatMessageContentItem[]> {
	if (typeof content === 'string') return content
	return Promise.all(content.map((item) => item.type === 'document' && 'data' in item.document ? documentPlaceholder(item.document) : item))
}

/** A message with its inline documents replaced by placeholders; only user and tool messages carry content items. */
export async function omitMessageDocumentData(message: LLMMessage): Promise<LLMMessage> {
	switch (message.role) {
		case 'user':
		case 'tool':
			return { ...message, content: await omitDocumentData(message.content) }
		case 'assistant':
		case 'system':
			return message
	}
}

const unavailable = (subject: string, reason: string): ChatMessageContentItemText => ({
	type: 'text',
	text: `[Document unavailable: ${subject} - ${reason}]`,
})

/** True when the session store already holds a file of `byteLength` bytes at `path`. */
async function isStored(path: string, byteLength: number, files: FileStore): Promise<boolean> {
	const stat = await files.session.stat(path)
	return stat.ok && stat.value.type === 'file' && stat.value.size === byteLength
}

/**
 * Writes an inline document to the session store under the hash of its bytes and refers to it from there.
 * A file already stored is not rewritten, so another agent reading it never sees it half-written.
 */
async function storeDocument(document: InlineDocument, files: FileStore): Promise<ChatMessageContentItemDocument | ChatMessageContentItemText> {
	const { mediaType, filename } = document
	const bytes = Buffer.from(document.data, 'base64')
	if (bytes.length === 0) return unavailable(describeDocument(document), 'empty file')
	if (bytes.subarray(0, 4).toString('latin1') !== '%PDF') return unavailable(describeDocument(document), 'not a PDF (no %PDF header)')

	const path = `${DOCUMENTS_DIR}/${await sha256Hex(bytes)}.pdf`
	if (!(await isStored(path, bytes.length, files))) {
		const written = await files.session.write(path, bytes)
		if (!written.ok) return unavailable(describeDocument(document), written.error)
	}
	const stored: StoredDocument = { mediaType, path, byteLength: bytes.length }
	if (filename !== undefined) stored.filename = filename
	return { type: 'document', document: stored }
}

/**
 * Writes an inline image to the session store under the hash of its bytes and refers to it by a
 * `file://` URL, which the providers' image processor reads back on each inference. A `data:` URL
 * that cannot be stored becomes a note, so its payload never reaches an event.
 */
async function storeImage(item: ChatMessageContentItemImage, files: FileStore): Promise<ChatMessageContentItemImage | ChatMessageContentItemText> {
	const { url } = item.imageUrl
	const match = DATA_URL.exec(url)
	if (match === null) return item
	const mediaType = (match[1] ?? '').toLowerCase()
	const unavailable = (reason: string): ChatMessageContentItemText => ({ type: 'text', text: `[Image unavailable: ${mediaType || 'data URL'} - ${reason}]` })
	const format = IMAGE_FORMATS.get(mediaType)
	if (format === undefined) return unavailable('unsupported format')
	if (!(match[2] ?? '').toLowerCase().split(';').includes('base64')) return unavailable('not base64-encoded')
	const bytes = Buffer.from(url.slice(match[0].length), 'base64')
	if (bytes.length === 0) return unavailable('empty file')

	const path = `${IMAGES_DIR}/${await sha256Hex(bytes)}.${format}`
	if (!(await isStored(path, bytes.length, files))) {
		const written = await files.session.write(path, bytes)
		if (!written.ok) return unavailable(written.error)
	}
	return { type: 'image_url', imageUrl: { ...item.imageUrl, url: `file://${path}` } }
}

/** A reference the agent did not create itself is kept only if it names a document the agent stored. */
async function checkStoredDocument(document: StoredDocument, files: FileStore): Promise<ChatMessageContentItemDocument | ChatMessageContentItemText> {
	if (STORED_DOCUMENT_PATH.test(document.path) && await isStored(document.path, document.byteLength, files)) {
		return { type: 'document', document }
	}
	return unavailable(document.path, `no stored document of ${document.byteLength} bytes at this path`)
}

/**
 * Content with every inline document and image moved to the session store and replaced by a reference,
 * which a provider reads back on each inference, so an event never holds their bytes.
 */
export async function storeInlineData(content: ToolResultContent, files: FileStore): Promise<ToolResultContent> {
	if (typeof content === 'string') return content
	return Promise.all(content.map((item) => {
		switch (item.type) {
			case 'text':
				return item
			case 'image_url':
				return storeImage(item, files)
			case 'document':
				return 'data' in item.document ? storeDocument(item.document, files) : checkStoredDocument(item.document, files)
		}
	}))
}

/** A message with its inline documents and images moved to the session store; only user and tool messages carry content items. */
export async function storeMessageInlineData(message: LLMMessage, files: FileStore): Promise<LLMMessage> {
	switch (message.role) {
		case 'user':
		case 'tool':
			return { ...message, content: await storeInlineData(message.content, files) }
		case 'assistant':
		case 'system':
			return message
	}
}

const documentByteLength = (document: InlineDocument | StoredDocument): number =>
	'data' in document ? base64ByteLength(document.data) : document.byteLength

/**
 * Messages whose documents total at most `budget` bytes: the newest documents are kept, and each one
 * that no longer fits is replaced by a note, so one request never reads more than the budget back.
 */
export function limitDocumentBytes(messages: LLMMessage[], budget: number = MAX_REQUEST_DOCUMENT_BYTES): LLMMessage[] {
	let used = 0
	const keepWithinBudget = (item: ChatMessageContentItem): ChatMessageContentItem => {
		if (item.type !== 'document') return item
		const size = documentByteLength(item.document)
		if (used + size > budget) {
			const subject = 'path' in item.document ? item.document.path : describeDocument(item.document)
			return { type: 'text', text: `[Document omitted: ${subject}, ${size} bytes, over the request budget of ${budget} bytes]` }
		}
		used += size
		return item
	}
	const newestFirst = [...messages].reverse().map((message): LLMMessage => {
		switch (message.role) {
			case 'user':
			case 'tool':
				return typeof message.content === 'string'
					? message
					: { ...message, content: [...message.content].reverse().map(keepWithinBudget).reverse() }
			case 'assistant':
			case 'system':
				return message
		}
	})
	return newestFirst.reverse()
}

async function readStoredDocument(document: StoredDocument, fileStore: FileStore | undefined): Promise<ResolvedContentItem> {
	const { mediaType, path, filename } = document
	if (fileStore === undefined) return unavailable(path, 'no file store to read it from')
	const read = await fileStore.session.read(path, { type: 'buffer' })
	if (!read.ok) return unavailable(path, read.error)
	const inline: InlineDocument = { mediaType, data: read.value.toString('base64') }
	if (filename !== undefined) inline.filename = filename
	return { type: 'document', document: inline }
}

/** Content with every stored document read back into its bytes, ready for a provider to send. */
export async function resolveDocuments(content: ToolResultContent, fileStore: FileStore | undefined): Promise<string | ResolvedContentItem[]> {
	if (typeof content === 'string') return content
	return Promise.all(content.map(async (item): Promise<ResolvedContentItem> => {
		switch (item.type) {
			case 'text':
			case 'image_url':
				return item
			case 'document':
				return 'data' in item.document ? { type: 'document', document: item.document } : readStoredDocument(item.document, fileStore)
		}
	}))
}
