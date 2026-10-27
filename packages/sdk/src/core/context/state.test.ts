import { describe, expect, test } from 'bun:test'
import { compactedConversationMessageSchema } from './state.js'

describe('compactedConversationMessageSchema', () => {
	test('accepts a document item in a user message and a tool result', () => {
		const document = { type: 'document', document: { mediaType: 'application/pdf', data: 'JVBERi0xLjQK', filename: 'scan.pdf' } }
		const user = { role: 'user', content: [{ type: 'text', text: 'Read this.' }, document] }
		const tool = { role: 'tool', toolCallId: 'tc_1', content: [document] }

		const parsedUser: unknown = compactedConversationMessageSchema.parse(user)
		const parsedTool: unknown = compactedConversationMessageSchema.parse(tool)
		expect(parsedUser).toEqual(user)
		expect(parsedTool).toEqual(tool)
	})

	test('accepts a stored document', () => {
		const message = {
			role: 'user',
			content: [{ type: 'document', document: { mediaType: 'application/pdf', path: '/home/user/session/.documents/abc.pdf', byteLength: 9 } }],
		}

		const parsed: unknown = compactedConversationMessageSchema.parse(message)
		expect(parsed).toEqual(message)
	})

	test('rejects a document of another media type', () => {
		const result = compactedConversationMessageSchema.safeParse({
			role: 'user',
			content: [{ type: 'document', document: { mediaType: 'text/plain', data: 'aGk=' } }],
		})

		expect(result.success).toBe(false)
	})
})
