import type { LLMMessage } from '~/core/agents/state.js'
import type { ChatMessageContentItem, ChatMessageContentItemDocument, ChatMessageContentItemText } from './llm-log-types.js'

/** Decoded size of a base64 payload, without decoding it. */
export function base64ByteLength(data: string): number {
	const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
	return Math.floor(data.length * 3 / 4) - padding
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * What a persisted request keeps of a document: the file stays identifiable by length and
 * hash, while the base64 payload would otherwise dominate every log entry and snapshot.
 * The base64 text is hashed as it is, never decoded, so a malformed payload cannot make it throw.
 */
export async function documentPlaceholder(item: ChatMessageContentItemDocument): Promise<ChatMessageContentItemText> {
	const { mediaType, data, filename } = item.document
	const name = filename === undefined ? '' : ` "${filename}"`
	const hash = await sha256Hex(data)
	return {
		type: 'text',
		text: `[document ${mediaType}${name}, ${data.length} base64 chars, base64 sha256 ${hash}; content omitted]`,
	}
}

/** Content with every document replaced by its placeholder; other items are kept as they are. */
export async function omitDocumentData(content: string | ChatMessageContentItem[]): Promise<string | ChatMessageContentItem[]> {
	if (typeof content === 'string' || !content.some((item) => item.type === 'document')) return content
	return Promise.all(content.map((item) => item.type === 'document' ? documentPlaceholder(item) : item))
}

/** A message with its documents replaced by placeholders; only user and tool messages carry content items. */
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
