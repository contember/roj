import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { LLMLogger } from '~/core/llm/logger.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createNodeFileSystem } from '~/testing/node-platform.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

// ============================================================================
// Helpers
// ============================================================================

function okValue<T>(result: { ok: boolean; value?: unknown }, schema: z.ZodType<T>): T {
	expect(result.ok).toBe(true)
	if (!result.ok) throw new Error('Expected ok result')
	return schema.parse(result.value)
}

const callEntrySchema = z.object({
	id: z.string(),
	status: z.string(),
	response: z.object({
		content: z.union([z.string(), z.null()]),
		toolCalls: z.array(z.unknown()),
		finishReason: z.string(),
	}).passthrough(),
}).passthrough()

const getCallsSchema = z.object({
	total: z.number(),
	calls: z.array(callEntrySchema),
})

const getCallSchema = z.object({
	id: z.string(),
	status: z.string(),
	request: z.object({
		model: z.string(),
		systemPrompt: z.string(),
		messages: z.array(z.unknown()),
	}).passthrough(),
	response: z.object({
		content: z.union([z.string(), z.null()]),
		toolCalls: z.array(z.unknown()),
		finishReason: z.string(),
	}).passthrough(),
	metrics: z.object({
		promptTokens: z.number(),
		completionTokens: z.number(),
		totalTokens: z.number(),
		latencyMs: z.number(),
	}).passthrough(),
}).passthrough()

function createHarnessWithLogger(options: { llmProvider?: MockLLMProvider } = {}) {
	const basePath = `/tmp/roj-test-llm-debug-${Math.random().toString(36).slice(2)}`
	const llmLogger = new LLMLogger({ basePath, enabled: true, fs: createNodeFileSystem() })
	const harness = new TestHarness({
		presets: [createTestPreset()],
		llmProvider: options.llmProvider,
		llmLogger,
	})
	return harness
}

// ============================================================================
// Tests
// ============================================================================

describe('llm-debug plugin', () => {
	it('after inference → getCalls returns at least one call entry', async () => {
		const harness = createHarnessWithLogger({
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Hello!', toolCalls: [] }),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Hi')

		const result = await session.callPluginMethod('llm.getCalls', {})
		const data = okValue(result, getCallsSchema)

		expect(data.total).toBeGreaterThanOrEqual(1)
		expect(data.calls.length).toBeGreaterThanOrEqual(1)

		await harness.shutdown()
	})

	it('getCall with specific callId → returns request, response, metrics', async () => {
		const harness = createHarnessWithLogger({
			llmProvider: MockLLMProvider.withFixedResponse({ content: 'Response text', toolCalls: [] }),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Test message')

		// Get calls to find a callId
		const listResult = await session.callPluginMethod('llm.getCalls', {})
		const listData = okValue(listResult, getCallsSchema)
		expect(listData.calls.length).toBeGreaterThanOrEqual(1)

		const callId = listData.calls[0].id

		// Get specific call
		const callResult = await session.callPluginMethod('llm.getCall', { callId })
		const callData = okValue(callResult, getCallSchema)

		expect(callData.id).toBe(callId)
		expect(callData.status).toBe('success')

		// Check request
		expect(callData.request.model).toBe('mock')
		expect(typeof callData.request.systemPrompt).toBe('string')
		expect(Array.isArray(callData.request.messages)).toBe(true)

		// Check response
		expect(callData.response.content).toBe('Response text')
		expect(callData.response.finishReason).toBe('stop')

		// Check metrics
		expect(typeof callData.metrics.promptTokens).toBe('number')
		expect(typeof callData.metrics.completionTokens).toBe('number')
		expect(typeof callData.metrics.totalTokens).toBe('number')
		expect(typeof callData.metrics.latencyMs).toBe('number')

		await harness.shutdown()
	})

	it('multiple inferences → getCalls returns all in order', async () => {
		const harness = createHarnessWithLogger({
			llmProvider: MockLLMProvider.withSequence([
				{ content: null, toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi' } }] },
				{ content: 'Done', toolCalls: [] },
			]),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Hello')

		const result = await session.callPluginMethod('llm.getCalls', {})
		const data = okValue(result, getCallsSchema)

		// Two inferences: first returns tool call, second returns text
		expect(data.total).toBe(2)
		expect(data.calls).toHaveLength(2)

		// listCalls returns most recent first, so calls[0] is the second inference
		const secondCall = data.calls[0]
		const firstCall = data.calls[1]

		expect(firstCall.response.content).toBeNull()
		expect(firstCall.response.toolCalls.length).toBe(1)

		expect(secondCall.response.content).toBe('Done')

		await harness.shutdown()
	})

	it('getCalls with limit/offset → pagination', async () => {
		const harness = createHarnessWithLogger({
			llmProvider: MockLLMProvider.withSequence([
				{ content: null, toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'A' } }] },
				{ content: null, toolCalls: [{ id: ToolCallId('tc2'), name: 'tell_user', input: { message: 'B' } }] },
				{ content: 'Done', toolCalls: [] },
			]),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Go')

		// Total should be 3
		const allResult = await session.callPluginMethod('llm.getCalls', {})
		const allData = okValue(allResult, getCallsSchema)
		expect(allData.total).toBe(3)

		// Limit to 1
		const limitResult = await session.callPluginMethod('llm.getCalls', { limit: 1 })
		const limitData = okValue(limitResult, getCallsSchema)
		expect(limitData.total).toBe(3)
		expect(limitData.calls.length).toBe(1)

		// Offset 1, limit 1
		const offsetResult = await session.callPluginMethod('llm.getCalls', { limit: 1, offset: 1 })
		const offsetData = okValue(offsetResult, getCallsSchema)
		expect(offsetData.total).toBe(3)
		expect(offsetData.calls.length).toBe(1)

		// The offset call should return a different call than limit-only
		expect(limitData.calls[0].id).not.toBe(offsetData.calls[0].id)

		await harness.shutdown()
	})
})
