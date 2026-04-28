import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'
import { agentEvents } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { ModelId } from '~/core/llm/schema.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import type { Preset } from '~/core/preset/index.js'
import { createTool } from '~/core/tools/definition.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { toolEvents } from '~/core/tools/state.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'

describe('agent processing loop', () => {
	// =========================================================================
	// basic flow
	// =========================================================================

	describe('basic flow', () => {
		it('message → inference → text response (no tools) → agent idle', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Hello back!', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			// Agent should have processed and gone back to pending
			const entryAgentId = session.getEntryAgentId()!
			const agentState = session.state.agents.get(entryAgentId)
			expect(agentState).toBeDefined()
			expect(agentState!.status).toBe('pending')

			// Inference events should exist
			const started = await session.getEventsByType('inference_started')
			const completed = await session.getEventsByType('inference_completed')
			expect(started).toHaveLength(1)
			expect(completed).toHaveLength(1)

			await harness.shutdown()
		})

		it('message → inference → 1 tool call → tool result → 2nd inference → idle', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Do something')

			const inferenceStarted = await session.getEventsByType('inference_started')
			const inferenceCompleted = await session.getEventsByType('inference_completed')
			expect(inferenceStarted).toHaveLength(2)
			expect(inferenceCompleted).toHaveLength(2)

			const toolStarted = await session.getEventsByType('tool_started')
			const toolCompleted = await session.getEventsByType('tool_completed')
			expect(toolStarted).toHaveLength(1)
			expect(toolCompleted).toHaveLength(1)

			await harness.shutdown()
		})

		it('message → inference → multiple tool calls → all executed → 2nd inference → idle', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [
							{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'First' } },
							{ id: ToolCallId('tc2'), name: 'tell_user', input: { message: 'Second' } },
						],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Do multiple things')

			const toolStarted = await session.getEventsByType('tool_started')
			const toolCompleted = await session.getEventsByType('tool_completed')
			expect(toolStarted).toHaveLength(2)
			expect(toolCompleted).toHaveLength(2)

			const messages = harness.notifications.getAgentMessages()
			expect(messages).toHaveLength(2)
			expect(messages[0].content).toBe('First')
			expect(messages[1].content).toBe('Second')

			await harness.shutdown()
		})

		it('message → inference → tool call → tool call → tool call → eventually finishes', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Step 1' } }],
					},
					{
						toolCalls: [{ id: ToolCallId('tc2'), name: 'tell_user', input: { message: 'Step 2' } }],
					},
					{
						toolCalls: [{ id: ToolCallId('tc3'), name: 'tell_user', input: { message: 'Step 3' } }],
					},
					{ content: 'All done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Multi step')

			const messages = harness.notifications.getAgentMessages()
			expect(messages).toHaveLength(3)

			const inferenceCompleted = await session.getEventsByType('inference_completed')
			expect(inferenceCompleted).toHaveLength(4)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// tool execution
	// =========================================================================

	describe('tool execution', () => {
		it('tool with valid input → executes successfully → result in history', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hello!' } }],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Test')

			const toolCompleted = await session.getEventsByType(toolEvents, 'tool_completed')
			expect(toolCompleted).toHaveLength(1)
			// tool_completed (not tool_failed) means execution succeeded
			const toolFailed = await session.getEventsByType(toolEvents, 'tool_failed')
			expect(toolFailed).toHaveLength(0)

			// The second inference should have the tool result in messages
			const lastRequest = harness.llmProvider.getLastRequest()
			const toolMessages = lastRequest?.messages.filter((m) => m.role === 'tool')
			expect(toolMessages?.length).toBeGreaterThanOrEqual(1)

			await harness.shutdown()
		})

		it('tool returning Err (recoverable) → error tool result, agent continues', async () => {
			const failingTool = createTool({
				name: 'failing_tool',
				description: 'A tool that returns a recoverable error',
				input: z.unknown(),
				execute: async () => ({ ok: false, error: { message: 'Something went wrong', recoverable: true } }),
			})

			const preset: Preset = {
				id: 'test',
				name: 'Test Preset',
				orchestrator: {
					system: 'You are a test agent.',
					model: ModelId('mock'),
					tools: [failingTool],
					agents: [],
					debounceMs: 0,
				},
				agents: [],
			}

			const harness = new TestHarness({
				presets: [preset],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'failing_tool', input: { value: 'test' } }],
					},
					{ content: 'Recovered', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Test error')

			// Tool should have failed with the recoverable error
			const toolFailed = await session.getEventsByType(toolEvents, 'tool_failed')
			expect(toolFailed).toHaveLength(1)
			expect(toolFailed[0].error).toContain('Something went wrong')

			// Agent should recover and continue to 2nd inference, ending in pending state
			const inferenceCompleted = await session.getEventsByType('inference_completed')
			expect(inferenceCompleted).toHaveLength(2)

			const entryAgentId = session.getEntryAgentId()!
			const agentState = session.state.agents.get(entryAgentId)
			expect(agentState!.status).toBe('pending')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// LLM errors
	// =========================================================================

	describe('LLM errors', () => {
		it('non-retryable LLM error → agent enters errored state', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				// invalid_request is non-retryable (unlike server_error which retries)
				llmProvider: MockLLMProvider.withError({ type: 'invalid_request', message: 'Bad request' }),
			})

			const session = await harness.createSession('test')
			await session.sendMessage('Trigger error')

			// Poll until agent enters errored state or timeout
			const entryAgentId = session.getEntryAgentId()!
			const deadline = Date.now() + 5000
			while (Date.now() < deadline) {
				const agentState = session.state.agents.get(entryAgentId)
				if (agentState?.status === 'errored') break
				await new Promise((r) => setTimeout(r, 50))
			}

			const agentState = session.state.agents.get(entryAgentId)
			expect(agentState!.status).toBe('errored')

			const failedEvents = await session.getEventsByType('inference_failed')
			expect(failedEvents).toHaveLength(1)

			await harness.shutdown()
		})

		it('agent with content + toolCalls in same response → both processed', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						content: 'Thinking about it...',
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Result' } }],
					},
					{ content: 'All done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Process both')

			// Tool should have been executed
			const toolCompleted = await session.getEventsByType('tool_completed')
			expect(toolCompleted).toHaveLength(1)

			// Content should be in conversation history
			const inferenceCompleted = await session.getEventsByType('inference_completed')
			expect(inferenceCompleted).toHaveLength(2)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// conversation history
	// =========================================================================

	describe('conversation history', () => {
		it('tool results appear in conversation history for next inference', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hello!' } }],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Test')

			// The second inference (last request) should have the tool result
			const lastRequest = harness.llmProvider.getLastRequest()
			const toolMessages = lastRequest?.messages.filter((m) => m.role === 'tool') ?? []
			expect(toolMessages.length).toBeGreaterThanOrEqual(1)

			await harness.shutdown()
		})

		it('system prompt passed to LLM as systemPrompt', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset({ orchestratorSystem: 'You are a helpful test assistant.' })],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok' }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			const lastRequest = harness.llmProvider.getLastRequest()
			expect(lastRequest?.systemPrompt).toContain('You are a helpful test assistant.')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// debounce
	// =========================================================================

	describe('debounce', () => {
		it('debounceMs: 0 → instant processing', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()], // debounceMs: 0 is default in test presets
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Fast!' }),
			})

			const session = await harness.createSession('test')
			const start = Date.now()
			await session.sendAndWaitForIdle('Quick')
			const elapsed = Date.now() - start

			// With debounceMs: 0, processing should be nearly instant
			expect(elapsed).toBeLessThan(2000)

			await harness.shutdown()
		})

		it('multiple messages sent rapidly → agent processes after single debounce', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Processed', toolCalls: [] }),
			})

			const session = await harness.createSession('test')

			// Send multiple messages without waiting for idle between them
			await session.sendMessage('First')
			await session.sendMessage('Second')
			await session.sendMessage('Third')
			await session.waitForIdle()

			// With debounceMs: 0, the setTimeout(fn, 0) fires as a macrotask.
			// All sendMessage calls complete in the microtask queue before the macrotask fires,
			// so the agent batches all 3 messages into a single inference cycle.
			const inferenceStarted = await session.getEventsByType('inference_started')
			expect(inferenceStarted).toHaveLength(1)

			// All 3 messages should be visible in the single LLM request (merged into one user message)
			const lastRequest = harness.llmProvider.getLastRequest()!
			const userMessage = lastRequest.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[User]'))
			expect(userMessage).toBeDefined()
			expect(userMessage!.content).toContain('First')
			expect(userMessage!.content).toContain('Second')
			expect(userMessage!.content).toContain('Third')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// tool execution — error paths
	// =========================================================================

	describe('tool execution — error paths', () => {
		it('tool with invalid input → validation error → returned as tool result', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						// tell_user requires { message: string }, pass invalid input
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { wrong_field: 123 } }],
					},
					{ content: 'Recovered from error', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Test invalid input')

			// Tool should have failed due to validation
			const toolFailed = await session.getEventsByType(toolEvents, 'tool_failed')
			expect(toolFailed).toHaveLength(1)
			expect(toolFailed[0].error).toContain('Invalid tool input')

			// Agent should recover and continue to second inference
			const inferenceCompleted = await session.getEventsByType('inference_completed')
			expect(inferenceCompleted).toHaveLength(2)

			// Agent should be in pending (idle) state, not errored
			const entryAgentId = session.getEntryAgentId()!
			expect(session.state.agents.get(entryAgentId)!.status).toBe('pending')

			await harness.shutdown()
		})

		it('tool throwing error → error captured as tool result', async () => {
			const throwingTool = createTool({
				name: 'exploding_tool',
				description: 'A tool that always throws',
				input: z.unknown(),
				execute: async () => {
					throw new Error('Tool exploded!')
				},
			})

			const preset: Preset = {
				id: 'test',
				name: 'Test Preset',
				orchestrator: {
					system: 'You are a test agent.',
					model: ModelId('mock'),
					tools: [throwingTool],
					agents: [],
					debounceMs: 0,
				},
				agents: [],
			}

			const harness = new TestHarness({
				presets: [preset],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'exploding_tool', input: { value: 'boom' } }],
					},
					{ content: 'Recovered', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Trigger explosion')

			// Tool should have failed with the thrown error message
			const toolFailed = await session.getEventsByType(toolEvents, 'tool_failed')
			expect(toolFailed).toHaveLength(1)
			expect(toolFailed[0].error).toContain('Tool exploded!')

			// Agent should recover and complete the second inference
			const inferenceCompleted = await session.getEventsByType('inference_completed')
			expect(inferenceCompleted).toHaveLength(2)

			// Agent should be in pending (idle) state
			const entryAgentId = session.getEntryAgentId()!
			expect(session.state.agents.get(entryAgentId)!.status).toBe('pending')

			await harness.shutdown()
		})
	})

	// =========================================================================
	// preamble
	// =========================================================================

	describe('preamble', () => {
		it('preamble messages included before conversation history', async () => {
			// Create a plugin that injects preamble on agent start
			const preamblePlugin = definePlugin('test-preamble')
				.hook('onStart', async (ctx) => {
					await ctx.emitEvent(agentEvents.create('preamble_added', {
						agentId: ctx.agentId,
						messages: [{ role: 'user', content: 'PREAMBLE_MARKER: You must follow these instructions.' }],
					}))
					return null
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok' }),
				systemPlugins: [preamblePlugin],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello after preamble')

			// Verify preamble_added event was emitted
			const preambleEvents = await session.getEventsByType('preamble_added')
			expect(preambleEvents).toHaveLength(1)

			// Verify the LLM request has preamble before the user message
			const lastRequest = harness.llmProvider.getLastRequest()!
			const messages = lastRequest.messages
			const preambleIdx = messages.findIndex((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('PREAMBLE_MARKER'))
			const userMsgIdx = messages.findIndex((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Hello after preamble'))

			expect(preambleIdx).toBeGreaterThanOrEqual(0)
			expect(userMsgIdx).toBeGreaterThanOrEqual(0)
			expect(preambleIdx).toBeLessThan(userMsgIdx)

			await harness.shutdown()
		})
	})
})
