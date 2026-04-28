import { beforeEach, describe, expect, it } from 'bun:test'
import type { AgentId } from '~/core/agents/schema.js'
import { generateTestAgentId } from '~/core/agents/schema.js'
import type { InferenceRequest, InferenceResponse, LLMError, LLMMessage, LLMProvider } from '~/core/llm/provider.js'
import { ModelId } from '~/core/llm/schema.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { generateSessionId } from '~/core/sessions/schema.js'
import { generateToolCallId } from '~/core/tools/schema.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { Result } from '~/lib/utils/result.js'
import { silentLogger } from '../../lib/logger/logger.js'
import { ContextCompactor, createContextCompactedEvent, formatMessageForSummary } from './context-compactor.js'
import type { CompactionConfig, CompactionResult } from './context-compactor.js'

// ============================================================================
// Test Constants
// ============================================================================

const TEST_MODEL_ID: ModelId = ModelId('test/model')

// ============================================================================
// Mock LLM Provider
// ============================================================================

class MockLLMProvider implements LLMProvider {
	readonly name = 'mock'
	private responses: InferenceResponse[] = []
	private responseIndex = 0
	calls: InferenceRequest[] = []

	setResponses(responses: InferenceResponse[]): void {
		this.responses = responses
		this.responseIndex = 0
	}

	async inference(
		request: InferenceRequest,
	): Promise<Result<InferenceResponse, LLMError>> {
		this.calls.push(request)
		if (this.responseIndex >= this.responses.length) {
			return Err({ type: 'server_error', message: 'No more mock responses' })
		}
		return Ok(this.responses[this.responseIndex++])
	}
}

// ============================================================================
// Tests: ContextCompactor.needsCompaction
// ============================================================================

describe('ContextCompactor.needsCompaction', () => {
	let mockLLM: MockLLMProvider
	let compactor: ContextCompactor

	beforeEach(() => {
		mockLLM = new MockLLMProvider()
		compactor = new ContextCompactor(mockLLM, silentLogger, {
			model: TEST_MODEL_ID,
			maxTokens: 100,
			keepRecentMessages: 2,
		})
	})

	it('returns false when below threshold', () => {
		const messages: LLMMessage[] = [{ role: 'user', content: 'short' }]
		expect(compactor.needsCompaction(messages)).toBe(false)
	})

	it('returns true when above threshold', () => {
		// Create messages with > 100 tokens
		const messages: LLMMessage[] = [
			{ role: 'user', content: 'a'.repeat(200) }, // ~50 tokens + overhead
			{ role: 'assistant', content: 'b'.repeat(200) }, // ~50 tokens + overhead
			{ role: 'user', content: 'c'.repeat(200) }, // ~50 tokens + overhead
		]
		expect(compactor.needsCompaction(messages)).toBe(true)
	})
})

// ============================================================================
// Tests: ContextCompactor.compact
// ============================================================================

describe('ContextCompactor.compact', () => {
	let mockLLM: MockLLMProvider
	let compactor: ContextCompactor
	let sessionId: SessionId
	let agentId: AgentId

	beforeEach(() => {
		mockLLM = new MockLLMProvider()
		compactor = new ContextCompactor(mockLLM, silentLogger, {
			model: TEST_MODEL_ID,
			maxTokens: 100,
			keepRecentMessages: 2,
		})
		sessionId = generateSessionId()
		agentId = generateTestAgentId()
	})

	it('returns empty summary when no messages to compact', async () => {
		// Only 2 messages, keepRecentMessages = 2
		const messages: LLMMessage[] = [
			{ role: 'user', content: 'message 1' },
			{ role: 'assistant', content: 'message 2' },
		]

		const result = await compactor.compact(sessionId, agentId, messages)
		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.summary).toBe('')
		expect(result.value.messagesRemoved).toBe(0)
		expect(result.value.compactedMessages).toEqual(messages)
	})

	it('compacts old messages and keeps recent ones', async () => {
		mockLLM.setResponses([
			{
				content: 'Summary of the conversation',
				toolCalls: [],
				finishReason: 'stop',
				metrics: {
					promptTokens: 50,
					completionTokens: 20,
					totalTokens: 70,
					latencyMs: 100,
					model: 'mock',
				},
			},
		])

		const messages: LLMMessage[] = [
			{ role: 'user', content: 'old message 1' },
			{ role: 'assistant', content: 'old message 2' },
			{ role: 'user', content: 'old message 3' },
			{ role: 'user', content: 'recent message 1' },
			{ role: 'assistant', content: 'recent message 2' },
		]

		const result = await compactor.compact(sessionId, agentId, messages)
		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.summary).toBe('Summary of the conversation')
		expect(result.value.messagesRemoved).toBe(3)
		expect(result.value.compactedMessages.length).toBe(3) // summary + 2 recent

		// First message is summary
		expect(result.value.compactedMessages[0].role).toBe('system')
		expect(result.value.compactedMessages[0].content).toContain(
			'[CONVERSATION SUMMARY]',
		)
		expect(result.value.compactedMessages[0].content).toContain(
			'Summary of the conversation',
		)

		// Recent messages preserved
		expect(result.value.compactedMessages[1].content).toBe('recent message 1')
		expect(result.value.compactedMessages[2].content).toBe('recent message 2')
	})

	it('calls LLM with formatted conversation and configured model', async () => {
		mockLLM.setResponses([
			{
				content: 'Summary',
				toolCalls: [],
				finishReason: 'stop',
				metrics: {
					promptTokens: 50,
					completionTokens: 20,
					totalTokens: 70,
					latencyMs: 100,
					model: 'mock',
				},
			},
		])

		const messages: LLMMessage[] = [
			{ role: 'user', content: 'user message' },
			{ role: 'assistant', content: 'assistant message' },
			{ role: 'user', content: 'recent' },
			{ role: 'assistant', content: 'recent too' },
		]

		await compactor.compact(sessionId, agentId, messages)

		expect(mockLLM.calls.length).toBe(1)
		const request = mockLLM.calls[0]
		// Verify model from config is used
		expect(request.model).toBe(TEST_MODEL_ID)
		expect(request.messages[0].role).toBe('user')
		expect(request.messages[0].content).toContain('User: user message')
		expect(request.messages[0].content).toContain('Agent: assistant message')
		// Recent messages should not be in the summarization request
		expect(request.messages[0].content).not.toContain('recent')
	})

	it('returns error when LLM fails', async () => {
		// No responses set, so LLM will fail

		const messages: LLMMessage[] = [
			{ role: 'user', content: 'old 1' },
			{ role: 'assistant', content: 'old 2' },
			{ role: 'user', content: 'old 3' },
			{ role: 'user', content: 'recent 1' },
			{ role: 'assistant', content: 'recent 2' },
		]

		const result = await compactor.compact(sessionId, agentId, messages)
		expect(result.ok).toBe(false)
		if (result.ok) return

		expect(result.error.message).toContain('Compaction failed')
	})
})

// ============================================================================
// Tests: ContextCompactor.compactIfNeeded
// ============================================================================

describe('ContextCompactor.compactIfNeeded', () => {
	let mockLLM: MockLLMProvider
	let compactor: ContextCompactor
	let sessionId: SessionId
	let agentId: AgentId

	beforeEach(() => {
		mockLLM = new MockLLMProvider()
		compactor = new ContextCompactor(mockLLM, silentLogger, {
			model: TEST_MODEL_ID,
			maxTokens: 50,
			keepRecentMessages: 1,
		})
		sessionId = generateSessionId()
		agentId = generateTestAgentId()
	})

	it('returns null when compaction not needed', async () => {
		const messages: LLMMessage[] = [{ role: 'user', content: 'short' }]

		const result = await compactor.compactIfNeeded(sessionId, agentId, messages)
		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value).toBeNull()
		expect(mockLLM.calls.length).toBe(0)
	})

	it('compacts when needed', async () => {
		mockLLM.setResponses([
			{
				content: 'Summary',
				toolCalls: [],
				finishReason: 'stop',
				metrics: {
					promptTokens: 50,
					completionTokens: 20,
					totalTokens: 70,
					latencyMs: 100,
					model: 'mock',
				},
			},
		])

		// Create messages exceeding threshold
		const messages: LLMMessage[] = [
			{ role: 'user', content: 'a'.repeat(100) },
			{ role: 'assistant', content: 'b'.repeat(100) },
			{ role: 'user', content: 'c'.repeat(100) },
		]

		const result = await compactor.compactIfNeeded(sessionId, agentId, messages)
		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value).not.toBeNull()
		expect(result.value!.summary).toBe('Summary')
	})
})

// ============================================================================
// Tests: createContextCompactedEvent
// ============================================================================

describe('createContextCompactedEvent', () => {
	it('creates event with correct fields', () => {
		const sessionId = generateSessionId()
		const agentId = generateTestAgentId()
		const result: CompactionResult = {
			compactedMessages: [
				{ role: 'system', content: 'summary' },
				{ role: 'user', content: 'recent' },
			],
			summary: 'The summary',
			originalTokens: 1000,
			compactedTokens: 200,
			messagesRemoved: 5,
		}

		const event = createContextCompactedEvent(sessionId, agentId, result)

		expect(event.type).toBe('context_compacted')
		expect(event.sessionId).toBe(sessionId)
		expect(event.agentId).toBe(agentId)
		expect(event.compactedContent).toBe('The summary')
		expect(event.originalTokens).toBe(1000)
		expect(event.compactedTokens).toBe(200)
		expect(event.messagesRemoved).toBe(5)
		expect(event.newConversationHistory.length).toBe(2)
		expect(event.newConversationHistory[0].role).toBe('system')
		expect(event.newConversationHistory[0].content).toBe('summary')
		expect(event.timestamp).toBeDefined()
	})

	it('converts tool role to system in history', () => {
		const sessionId = generateSessionId()
		const agentId = generateTestAgentId()
		const toolCallId = generateToolCallId()
		const result: CompactionResult = {
			compactedMessages: [{ role: 'tool', content: 'tool result', toolCallId }],
			summary: '',
			originalTokens: 100,
			compactedTokens: 50,
			messagesRemoved: 0,
		}

		const event = createContextCompactedEvent(sessionId, agentId, result)

		// tool role should be converted to system
		expect(event.newConversationHistory[0].role).toBe('system')
	})
})

// ============================================================================
// Tests: Default config
// ============================================================================

describe('ContextCompactor with custom config', () => {
	it('respects custom maxTokens', () => {
		const mockLLM = new MockLLMProvider()
		const config: CompactionConfig = {
			model: TEST_MODEL_ID,
			maxTokens: 20,
			keepRecentMessages: 1,
		}
		const compactor = new ContextCompactor(mockLLM, silentLogger, config)

		const smallMessages: LLMMessage[] = [{ role: 'user', content: 'hi' }]
		expect(compactor.needsCompaction(smallMessages)).toBe(false)

		const largeMessages: LLMMessage[] = [
			{ role: 'user', content: 'a'.repeat(100) },
		]
		expect(compactor.needsCompaction(largeMessages)).toBe(true)
	})

	it('respects custom keepRecentMessages', async () => {
		const mockLLM = new MockLLMProvider()
		mockLLM.setResponses([
			{
				content: 'Summary',
				toolCalls: [],
				finishReason: 'stop',
				metrics: {
					promptTokens: 50,
					completionTokens: 20,
					totalTokens: 70,
					latencyMs: 100,
					model: 'mock',
				},
			},
		])

		const config: CompactionConfig = {
			model: TEST_MODEL_ID,
			maxTokens: 10,
			keepRecentMessages: 3,
		}
		const compactor = new ContextCompactor(mockLLM, silentLogger, config)

		const messages: LLMMessage[] = [
			{ role: 'user', content: 'old 1' },
			{ role: 'assistant', content: 'old 2' },
			{ role: 'user', content: 'recent 1' },
			{ role: 'assistant', content: 'recent 2' },
			{ role: 'user', content: 'recent 3' },
		]

		const result = await compactor.compact(
			generateSessionId(),
			generateTestAgentId(),
			messages,
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return

		// 2 old messages removed, 3 kept + 1 summary = 4 total
		expect(result.value.messagesRemoved).toBe(2)
		expect(result.value.compactedMessages.length).toBe(4)
	})

	it('uses custom summaryPrompt', async () => {
		const mockLLM = new MockLLMProvider()
		mockLLM.setResponses([
			{
				content: 'Summary',
				toolCalls: [],
				finishReason: 'stop',
				metrics: {
					promptTokens: 50,
					completionTokens: 20,
					totalTokens: 70,
					latencyMs: 100,
					model: 'mock',
				},
			},
		])

		const customPrompt = 'Custom summary instructions'
		const config: CompactionConfig = {
			model: TEST_MODEL_ID,
			maxTokens: 10,
			keepRecentMessages: 1,
			summaryPrompt: customPrompt,
		}
		const compactor = new ContextCompactor(mockLLM, silentLogger, config)

		const messages: LLMMessage[] = [
			{ role: 'user', content: 'old' },
			{ role: 'user', content: 'recent' },
		]

		await compactor.compact(generateSessionId(), generateTestAgentId(), messages)

		expect(mockLLM.calls.length).toBe(1)
		expect(mockLLM.calls[0].systemPrompt).toBe(customPrompt)
	})
})

// ============================================================================
// Tests: formatMessageForSummary
// ============================================================================

describe('formatMessageForSummary', () => {
	it('formats user message', () => {
		const msg: LLMMessage = { role: 'user', content: 'Hello world' }
		expect(formatMessageForSummary(msg)).toBe('User: Hello world')
	})

	it('formats user message with multimodal content', () => {
		const msg: LLMMessage = {
			role: 'user',
			content: [{ type: 'text', text: 'Check this image' }],
		}
		const result = formatMessageForSummary(msg)
		expect(result).toContain('User:')
		expect(result).toContain('Check this image')
	})

	it('formats assistant message with text only', () => {
		const msg: LLMMessage = { role: 'assistant', content: 'Sure, I can help' }
		expect(formatMessageForSummary(msg)).toBe('Agent: Sure, I can help')
	})

	it('formats assistant message with tool calls', () => {
		const msg: LLMMessage = {
			role: 'assistant',
			content: '',
			toolCalls: [{ id: generateToolCallId(), name: 'read', input: { path: '/src/index.ts' } }],
		}
		const result = formatMessageForSummary(msg)
		expect(result).toBe('Agent: [Called tools: read(path)]')
	})

	it('formats assistant message with text and tool calls', () => {
		const msg: LLMMessage = {
			role: 'assistant',
			content: 'Let me read that file.',
			toolCalls: [{ id: generateToolCallId(), name: 'read', input: { path: '/src/index.ts' } }],
		}
		const result = formatMessageForSummary(msg)
		expect(result).toContain('Agent: Let me read that file.')
		expect(result).toContain('[Called tools: read(path)]')
	})

	it('formats assistant message with multiple tool calls', () => {
		const msg: LLMMessage = {
			role: 'assistant',
			content: '',
			toolCalls: [
				{ id: generateToolCallId(), name: 'read', input: { path: '/a.ts' } },
				{ id: generateToolCallId(), name: 'edit', input: { path: '/b.ts', old_string: 'x', new_string: 'y' } },
			],
		}
		const result = formatMessageForSummary(msg)
		expect(result).toBe('Agent: [Called tools: read(path), edit(path, old_string, new_string)]')
	})

	it('formats tool result with tool name', () => {
		const msg: LLMMessage = {
			role: 'tool',
			content: 'export function main() {}',
			toolCallId: generateToolCallId(),
			toolName: 'read',
		}
		const result = formatMessageForSummary(msg)
		expect(result).toBe('Tool(read): export function main() {}')
	})

	it('formats tool result without tool name as unknown', () => {
		const msg: LLMMessage = {
			role: 'tool',
			content: 'some result',
			toolCallId: generateToolCallId(),
		}
		const result = formatMessageForSummary(msg)
		expect(result).toBe('Tool(unknown): some result')
	})

	it('truncates large tool results', () => {
		const largeContent = 'x'.repeat(1000)
		const msg: LLMMessage = {
			role: 'tool',
			content: largeContent,
			toolCallId: generateToolCallId(),
			toolName: 'read',
		}
		const result = formatMessageForSummary(msg)
		expect(result).toContain('Tool(read):')
		expect(result).toContain('...(truncated)...')
		expect(result.length).toBeLessThan(largeContent.length)
	})

	it('does not truncate small tool results', () => {
		const smallContent = 'small result'
		const msg: LLMMessage = {
			role: 'tool',
			content: smallContent,
			toolCallId: generateToolCallId(),
			toolName: 'read',
		}
		const result = formatMessageForSummary(msg)
		expect(result).toBe('Tool(read): small result')
		expect(result).not.toContain('truncated')
	})

	it('formats system message', () => {
		const msg: LLMMessage = { role: 'system', content: 'You are an assistant.' }
		expect(formatMessageForSummary(msg)).toBe('System: You are an assistant.')
	})
})

// ============================================================================
// Tests: Tool calls in compaction
// ============================================================================

describe('ContextCompactor with tool calls', () => {
	let mockLLM: MockLLMProvider
	let compactor: ContextCompactor
	let sessionId: SessionId
	let agentId: AgentId

	beforeEach(() => {
		mockLLM = new MockLLMProvider()
		compactor = new ContextCompactor(mockLLM, silentLogger, {
			model: TEST_MODEL_ID,
			maxTokens: 100,
			keepRecentMessages: 1,
		})
		sessionId = generateSessionId()
		agentId = generateTestAgentId()
	})

	it('does not leave orphaned tool results at the start of kept messages', async () => {
		mockLLM.setResponses([
			{
				content: 'Summary',
				toolCalls: [],
				finishReason: 'stop',
				metrics: { promptTokens: 50, completionTokens: 20, totalTokens: 70, latencyMs: 100, model: 'mock' },
			},
		])

		const toolCallId = generateToolCallId()
		// keepRecentMessages=1 would split between the assistant (tool call) and tool result
		const messages: LLMMessage[] = [
			{ role: 'user', content: 'old message' },
			{ role: 'assistant', content: 'old response' },
			{ role: 'user', content: 'Read the file' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: toolCallId, name: 'read', input: { path: '/src/index.ts' } }],
			},
			{ role: 'tool', content: 'export const foo = 1', toolCallId, toolName: 'read' },
		]

		const result = await compactor.compact(sessionId, agentId, messages)
		expect(result.ok).toBe(true)
		if (!result.ok) return

		// The tool result must NOT be the first kept message — it should be compacted along with its tool call
		const keptMessages = result.value.compactedMessages.filter(m => m.role !== 'system')
		for (const msg of keptMessages) {
			expect(msg.role).not.toBe('tool')
		}
		// All 5 original messages should be compacted (none kept except summary)
		expect(result.value.messagesRemoved).toBe(5)
	})

	it('includes tool calls in summarization request', async () => {
		mockLLM.setResponses([
			{
				content: 'Summary',
				toolCalls: [],
				finishReason: 'stop',
				metrics: { promptTokens: 50, completionTokens: 20, totalTokens: 70, latencyMs: 100, model: 'mock' },
			},
		])

		const toolCallId = generateToolCallId()
		const messages: LLMMessage[] = [
			{ role: 'user', content: 'Read the file' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: toolCallId, name: 'read', input: { path: '/src/index.ts' } }],
			},
			{ role: 'tool', content: 'export const foo = 1', toolCallId, toolName: 'read' },
			{ role: 'user', content: 'recent message' },
		]

		await compactor.compact(sessionId, agentId, messages)

		expect(mockLLM.calls.length).toBe(1)
		const request = mockLLM.calls[0]
		const summaryContent = request.messages[0].content as string

		// Verify tool call is included
		expect(summaryContent).toContain('[Called tools: read(path)]')
		// Verify tool result includes tool name
		expect(summaryContent).toContain('Tool(read):')
		expect(summaryContent).toContain('export const foo = 1')
	})
})

// ============================================================================
// Tests: History offloading
// ============================================================================

describe('ContextCompactor with history offloading', () => {
	let mockLLM: MockLLMProvider
	let sessionId: SessionId
	let agentId: AgentId

	beforeEach(() => {
		mockLLM = new MockLLMProvider()
		sessionId = generateSessionId()
		agentId = generateTestAgentId()
	})

	it('offloads history when enabled and offloader is provided', async () => {
		const offloadedPaths: { agentId: AgentId; content: string; pathPrefix: string }[] = []
		const mockOffloader = {
			async offload(agentId: AgentId, content: string, pathPrefix: string): Promise<string> {
				offloadedPaths.push({ agentId, content, pathPrefix })
				return `${pathPrefix}${agentId}/history.md`
			},
		}

		mockLLM.setResponses([
			{
				content: 'Summary',
				toolCalls: [],
				finishReason: 'stop',
				metrics: { promptTokens: 50, completionTokens: 20, totalTokens: 70, latencyMs: 100, model: 'mock' },
			},
		])

		const compactor = new ContextCompactor(
			mockLLM,
			silentLogger,
			{
				model: TEST_MODEL_ID,
				maxTokens: 100,
				keepRecentMessages: 1,
				offloadHistory: true,
			},
			mockOffloader,
		)

		const messages: LLMMessage[] = [
			{ role: 'user', content: 'old message 1' },
			{ role: 'assistant', content: 'old message 2' },
			{ role: 'user', content: 'recent message' },
		]

		const result = await compactor.compact(sessionId, agentId, messages)

		expect(result.ok).toBe(true)
		if (!result.ok) return

		// Verify offloader was called
		expect(offloadedPaths.length).toBe(1)
		expect(offloadedPaths[0].agentId).toBe(agentId)
		expect(offloadedPaths[0].content).toContain('User: old message 1')
		expect(offloadedPaths[0].pathPrefix).toBe('/session/.history/')

		// Verify result contains historyPath
		expect(result.value.historyPath).toBe(`/session/.history/${agentId}/history.md`)

		// Verify summary message contains history reference
		expect(result.value.compactedMessages[0].content).toContain('has been saved to')
		expect(result.value.compactedMessages[0].content).toContain(`/session/.history/${agentId}/history.md`)
	})

	it('does not offload history when disabled', async () => {
		const mockOffloader = {
			async offload(): Promise<string> {
				throw new Error('Should not be called')
			},
		}

		mockLLM.setResponses([
			{
				content: 'Summary',
				toolCalls: [],
				finishReason: 'stop',
				metrics: { promptTokens: 50, completionTokens: 20, totalTokens: 70, latencyMs: 100, model: 'mock' },
			},
		])

		const compactor = new ContextCompactor(
			mockLLM,
			silentLogger,
			{
				model: TEST_MODEL_ID,
				maxTokens: 100,
				keepRecentMessages: 1,
				offloadHistory: false, // explicitly disabled
			},
			mockOffloader,
		)

		const messages: LLMMessage[] = [
			{ role: 'user', content: 'old' },
			{ role: 'user', content: 'recent' },
		]

		const result = await compactor.compact(sessionId, agentId, messages)

		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.historyPath).toBeUndefined()
		expect(result.value.compactedMessages[0].content).not.toContain('has been saved to')
	})

	it('does not offload history when offloader is not provided', async () => {
		mockLLM.setResponses([
			{
				content: 'Summary',
				toolCalls: [],
				finishReason: 'stop',
				metrics: { promptTokens: 50, completionTokens: 20, totalTokens: 70, latencyMs: 100, model: 'mock' },
			},
		])

		const compactor = new ContextCompactor(
			mockLLM,
			silentLogger,
			{
				model: TEST_MODEL_ID,
				maxTokens: 100,
				keepRecentMessages: 1,
				offloadHistory: true, // enabled but no offloader
			},
			// no offloader provided
		)

		const messages: LLMMessage[] = [
			{ role: 'user', content: 'old' },
			{ role: 'user', content: 'recent' },
		]

		const result = await compactor.compact(sessionId, agentId, messages)

		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.historyPath).toBeUndefined()
	})

	it('uses custom historyPathPrefix', async () => {
		const offloadedPaths: { pathPrefix: string }[] = []
		const mockOffloader = {
			async offload(_agentId: AgentId, _content: string, pathPrefix: string): Promise<string> {
				offloadedPaths.push({ pathPrefix })
				return `/custom/path/history.md`
			},
		}

		mockLLM.setResponses([
			{
				content: 'Summary',
				toolCalls: [],
				finishReason: 'stop',
				metrics: { promptTokens: 50, completionTokens: 20, totalTokens: 70, latencyMs: 100, model: 'mock' },
			},
		])

		const compactor = new ContextCompactor(
			mockLLM,
			silentLogger,
			{
				model: TEST_MODEL_ID,
				maxTokens: 100,
				keepRecentMessages: 1,
				offloadHistory: true,
				historyPathPrefix: '/session/.custom-history/',
			},
			mockOffloader,
		)

		const messages: LLMMessage[] = [
			{ role: 'user', content: 'old' },
			{ role: 'user', content: 'recent' },
		]

		await compactor.compact(sessionId, agentId, messages)

		expect(offloadedPaths.length).toBe(1)
		expect(offloadedPaths[0].pathPrefix).toBe('/session/.custom-history/')
	})

	it('continues compaction even if offloading fails', async () => {
		const mockOffloader = {
			async offload(): Promise<string> {
				throw new Error('Disk full')
			},
		}

		mockLLM.setResponses([
			{
				content: 'Summary despite offload failure',
				toolCalls: [],
				finishReason: 'stop',
				metrics: { promptTokens: 50, completionTokens: 20, totalTokens: 70, latencyMs: 100, model: 'mock' },
			},
		])

		const compactor = new ContextCompactor(
			mockLLM,
			silentLogger,
			{
				model: TEST_MODEL_ID,
				maxTokens: 100,
				keepRecentMessages: 1,
				offloadHistory: true,
			},
			mockOffloader,
		)

		const messages: LLMMessage[] = [
			{ role: 'user', content: 'old' },
			{ role: 'user', content: 'recent' },
		]

		const result = await compactor.compact(sessionId, agentId, messages)

		// Compaction should succeed despite offload failure
		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.summary).toBe('Summary despite offload failure')
		expect(result.value.historyPath).toBeUndefined()
	})
})

// ============================================================================
// Tests: createContextCompactedEvent with historyPath
// ============================================================================

describe('createContextCompactedEvent with historyPath', () => {
	it('includes historyPath in event when provided', () => {
		const sessionId = generateSessionId()
		const agentId = generateTestAgentId()
		const result: CompactionResult = {
			compactedMessages: [
				{ role: 'system', content: 'summary' },
			],
			summary: 'The summary',
			originalTokens: 1000,
			compactedTokens: 200,
			messagesRemoved: 5,
			historyPath: '/session/.history/agent-1/history.md',
		}

		const event = createContextCompactedEvent(sessionId, agentId, result)

		expect(event.historyPath).toBe('/session/.history/agent-1/history.md')
	})

	it('does not include historyPath when not provided', () => {
		const sessionId = generateSessionId()
		const agentId = generateTestAgentId()
		const result: CompactionResult = {
			compactedMessages: [
				{ role: 'system', content: 'summary' },
			],
			summary: 'The summary',
			originalTokens: 1000,
			compactedTokens: 200,
			messagesRemoved: 5,
		}

		const event = createContextCompactedEvent(sessionId, agentId, result)

		expect(event.historyPath).toBeUndefined()
	})
})
