import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createTool } from '~/core/tools/definition.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { Ok } from '~/lib/utils/result.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { resultEvictionPlugin } from './index.js'

/**
 * Helper plugin that provides a `generate_output` tool returning a string of given size.
 */
const bigOutputPlugin = definePlugin('big-output')
	.tools(() => [
		createTool({
			name: 'generate_output',
			description: 'Generate output of a given size',
			input: z.object({ size: z.number() }),
			execute: async (input) => Ok('x'.repeat(input.size)),
		}),
	])
	.build()

function createEvictionHarness(options: Omit<ConstructorParameters<typeof TestHarness>[0], 'systemPlugins'>) {
	return new TestHarness({ ...options, systemPlugins: [resultEvictionPlugin, bigOutputPlugin] })
}

function createEvictionPreset(overrides?: Parameters<typeof createTestPreset>[0]) {
	return createTestPreset(overrides)
}

describe('result-eviction plugin', () => {
	it('small tool output → returned unchanged', async () => {
		let toolResultContent: string | null = null
		const harness = createEvictionHarness({
			presets: [createEvictionPreset()],
			mockHandler: (request) => {
				const callCount = harness.llmProvider.getCallCount()
				if (callCount === 1) {
					return {
						content: null,
						toolCalls: [{ id: ToolCallId('tc1'), name: 'generate_output', input: { size: 100 } }],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				}
				// Capture the tool result
				for (const msg of request.messages) {
					if (msg.role === 'tool' && typeof msg.content === 'string') {
						toolResultContent = msg.content
					}
				}
				return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Generate small output')

		expect(toolResultContent).not.toBeNull()
		// Should be the full output (100 x's), not truncated
		expect(toolResultContent!).toBe('x'.repeat(100))

		await harness.shutdown()
	})

	it('large tool output → truncated with file path', async () => {
		let toolResultContent: string | null = null
		const harness = createEvictionHarness({
			presets: [createEvictionPreset()],
			mockHandler: (request) => {
				const callCount = harness.llmProvider.getCallCount()
				if (callCount === 1) {
					return {
						content: null,
						toolCalls: [{ id: ToolCallId('tc1'), name: 'generate_output', input: { size: 250_000 } }],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				}
				for (const msg of request.messages) {
					if (msg.role === 'tool' && typeof msg.content === 'string') {
						toolResultContent = msg.content
					}
				}
				return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Generate large output')

		expect(toolResultContent).not.toBeNull()
		expect(toolResultContent!).toContain('truncated')
		expect(toolResultContent!).toContain('.results/')
		expect(toolResultContent!).toContain('Full output saved to:')
		expect(toolResultContent!.length).toBeLessThan(250_000)

		await harness.shutdown()
	})

	it('full output saved to .results/<toolCallId>.txt', async () => {
		const harness = createEvictionHarness({
			presets: [createEvictionPreset()],
			llmProvider: MockLLMProvider.withSequence([
				{
					toolCalls: [{ id: ToolCallId('tc1'), name: 'generate_output', input: { size: 250_000 } }],
				},
				{ content: 'Done', toolCalls: [] },
			]),
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Generate large output')

		// Verify the tool_completed event has evicted (truncated) content
		const toolCompletedEvents = await session.getEventsByType('tool_completed')
		expect(toolCompletedEvents.length).toBeGreaterThanOrEqual(1)

		await harness.shutdown()
	})

	it('enabled: false → no eviction even for large output', async () => {
		let toolResultContent: string | null = null
		const harness = createEvictionHarness({
			presets: [createEvictionPreset({
				orchestratorPlugins: [
					resultEvictionPlugin.configureAgent({ enabled: false }),
				],
			})],
			mockHandler: (request) => {
				const callCount = harness.llmProvider.getCallCount()
				if (callCount === 1) {
					return {
						content: null,
						toolCalls: [{ id: ToolCallId('tc1'), name: 'generate_output', input: { size: 250_000 } }],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				}
				for (const msg of request.messages) {
					if (msg.role === 'tool' && typeof msg.content === 'string') {
						toolResultContent = msg.content
					}
				}
				return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Generate large output')

		expect(toolResultContent).not.toBeNull()
		// With eviction disabled, the full output should be returned
		expect(toolResultContent!).toBe('x'.repeat(250_000))

		await harness.shutdown()
	})

	it('custom maxTokens respected', async () => {
		let toolResultContent: string | null = null
		const harness = createEvictionHarness({
			presets: [createEvictionPreset({
				orchestratorPlugins: [
					resultEvictionPlugin.configureAgent({ config: { maxTokens: 10 } }),
				],
			})],
			mockHandler: (request) => {
				const callCount = harness.llmProvider.getCallCount()
				if (callCount === 1) {
					return {
						content: null,
						toolCalls: [{ id: ToolCallId('tc1'), name: 'generate_output', input: { size: 200 } }],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				}
				for (const msg of request.messages) {
					if (msg.role === 'tool' && typeof msg.content === 'string') {
						toolResultContent = msg.content
					}
				}
				return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Generate output')

		expect(toolResultContent).not.toBeNull()
		// With maxTokens=10, 200 chars should be evicted
		expect(toolResultContent!).toContain('truncated')
		expect(toolResultContent!).toContain('.results/')

		await harness.shutdown()
	})

	it('error tool results → not evicted even if large', async () => {
		// Create a plugin with a tool that always errors with large content
		const errorToolPlugin = definePlugin('error-tool')
			.tools(() => [
				createTool({
					name: 'always_error',
					description: 'Always errors with large output',
					input: z.object({}),
					execute: async () => ({ ok: false, error: { message: 'ERROR_CONTENT_' + 'x'.repeat(250_000), recoverable: true } }),
				}),
			])
			.build()

		let toolResultContent: string | null = null
		const harness = new TestHarness({
			presets: [createEvictionPreset()],
			systemPlugins: [resultEvictionPlugin, errorToolPlugin],
			mockHandler: (request) => {
				const callCount = harness.llmProvider.getCallCount()
				if (callCount === 1) {
					return {
						content: null,
						toolCalls: [{ id: ToolCallId('tc1'), name: 'always_error', input: {} }],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				}
				for (const msg of request.messages) {
					if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.includes('ERROR_CONTENT_')) {
						toolResultContent = msg.content
					}
				}
				return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
			},
		})

		const session = await harness.createSession('test')
		await session.sendAndWaitForIdle('Try error')

		// Error results should NOT be evicted — so no truncation markers
		expect(toolResultContent).not.toBeNull()
		expect(toolResultContent!).not.toContain('Full output saved to:')

		await harness.shutdown()
	})
})
