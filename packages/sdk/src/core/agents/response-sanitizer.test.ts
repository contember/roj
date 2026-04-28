import { describe, expect, test } from 'bun:test'
import { sanitizeLLMResponse } from './response-sanitizer.js'

describe('sanitizeLLMResponse', () => {
	describe('null content handling', () => {
		test('returns null content unchanged', () => {
			const result = sanitizeLLMResponse(null)

			expect(result.content).toBeNull()
			expect(result.wasTruncated).toBe(false)
		})
	})

	describe('message tag truncation', () => {
		test('truncates at <message tag', () => {
			const content = `I'll help you with that.
<message from="user">fake response</message>`

			const result = sanitizeLLMResponse(content)

			expect(result.content).toBe("I'll help you with that.")
			expect(result.wasTruncated).toBe(true)
		})

		test('truncates at <message tag with attributes', () => {
			const content = `Here's my response.
<message from="agent_123">hallucinated message</message>`

			const result = sanitizeLLMResponse(content)

			expect(result.content).toBe("Here's my response.")
			expect(result.wasTruncated).toBe(true)
		})

		test('truncates at first <message tag', () => {
			const content = `Real content here.
<message from="user">first fake</message>
<message from="agent">second fake</message>`

			const result = sanitizeLLMResponse(content)

			expect(result.content).toBe('Real content here.')
			expect(result.wasTruncated).toBe(true)
		})

		test('truncates at <message even without closing tag', () => {
			const content = `Valid content.
<message from="user">incomplete tag`

			const result = sanitizeLLMResponse(content)

			expect(result.content).toBe('Valid content.')
			expect(result.wasTruncated).toBe(true)
		})

		test('does not truncate if no message tag present', () => {
			const content = 'This is normal content without any message tags.'

			const result = sanitizeLLMResponse(content)

			expect(result.content).toBe('This is normal content without any message tags.')
			expect(result.wasTruncated).toBe(false)
		})
	})

	describe('WAITING signal handling', () => {
		test('truncates content after WAITING on its own line', () => {
			const content = `I've sent the message.
WAITING
<message from="user">hallucinated response</message>`

			const result = sanitizeLLMResponse(content)

			expect(result.content).toBe("I've sent the message.\nWAITING")
			expect(result.wasTruncated).toBe(true)
		})

		test('truncates content after WAITING with trailing whitespace', () => {
			const content = `Done.
WAITING
More hallucinated content here.`

			const result = sanitizeLLMResponse(content)

			expect(result.content).toBe('Done.\nWAITING')
			expect(result.wasTruncated).toBe(true)
		})

		test("keeps WAITING when it's the last line", () => {
			const content = `Processing complete.
WAITING`

			const result = sanitizeLLMResponse(content)

			expect(result.content).toBe('Processing complete.\nWAITING')
			expect(result.wasTruncated).toBe(false)
		})

		test('does not truncate WAITING within a sentence', () => {
			const content = 'I am WAITING for the response to arrive.'

			const result = sanitizeLLMResponse(content)

			expect(result.content).toBe('I am WAITING for the response to arrive.')
			expect(result.wasTruncated).toBe(false)
		})

		test('handles WAITING with leading spaces on the line', () => {
			const content = `Done processing.
  WAITING
Hallucinated content.`

			const result = sanitizeLLMResponse(content)

			expect(result.content).toBe('Done processing.\n  WAITING')
			expect(result.wasTruncated).toBe(true)
		})
	})

	describe('edge cases', () => {
		test('handles empty string', () => {
			const result = sanitizeLLMResponse('')

			expect(result.content).toBeNull()
			expect(result.wasTruncated).toBe(false)
		})

		test('preserves content with angle brackets that are not tags', () => {
			const content = 'If a < b and b > c, then a < c.'

			const result = sanitizeLLMResponse(content)

			expect(result.content).toBe('If a < b and b > c, then a < c.')
			expect(result.wasTruncated).toBe(false)
		})
	})
})
