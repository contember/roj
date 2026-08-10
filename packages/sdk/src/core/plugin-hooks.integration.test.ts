import { describe, expect, it } from 'bun:test'
import { agentEvents } from '~/core/agents/state.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { toolEvents } from '~/core/tools/state.js'
import { Ok } from '~/lib/utils/result.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import z from 'zod/v4'

describe('core: plugin hooks', () => {
	// =========================================================================
	// Agent hooks
	// =========================================================================

	describe('agent hooks', () => {
		it('onStart fires when agent starts first processing cycle', async () => {
			const calls: string[] = []

			const trackingPlugin = definePlugin('tracking')
				.hook('onStart', async () => {
					calls.push('onStart')
					return null
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [trackingPlugin],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			expect(calls).toContain('onStart')

			// handler_completed is emitted for onStart (reducer uses it for onStartCalled)
			const handlerCompleted = await session.getEventsByType(agentEvents, 'handler_completed')
			const onStartEvents = handlerCompleted.filter((e) => e.handlerName === 'onStart')
			expect(onStartEvents.length).toBeGreaterThan(0)

			await harness.shutdown()
		})

		it('beforeInference fires before LLM call with turnNumber', async () => {
			const turnNumbers: number[] = []

			const trackingPlugin = definePlugin('tracking')
				.hook('beforeInference', async (ctx) => {
					turnNumbers.push(ctx.turnNumber)
					return null
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
					},
					{ content: 'Done', toolCalls: [] },
				]),
				systemPlugins: [trackingPlugin],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			// beforeInference should fire for each inference turn
			expect(turnNumbers.length).toBe(2)
			expect(turnNumbers[0]).toBe(1)
			expect(turnNumbers[1]).toBe(2)

			await harness.shutdown()
		})

		it('afterInference fires after LLM response', async () => {
			let capturedResponse: { content: string | null } | null = null

			const trackingPlugin = definePlugin('tracking')
				.hook('afterInference', async (ctx) => {
					capturedResponse = { content: ctx.response.content }
					return null
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Hello back!', toolCalls: [] }),
				systemPlugins: [trackingPlugin],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			expect(capturedResponse).not.toBeNull()
			expect(capturedResponse!.content).toBe('Hello back!')

			await harness.shutdown()
		})

		it('afterInference returning { action: "pause" } → agent paused', async () => {
			const trackingPlugin = definePlugin('tracking')
				.hook('afterInference', async () => {
					return { action: 'pause', reason: 'test pause' }
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [trackingPlugin],
			})

			const session = await harness.createSession('test')
			await session.sendMessage('Hello')

			// Wait for agent to reach paused state
			const entryAgentId = session.getEntryAgentId()!
			const deadline = Date.now() + 5000
			while (Date.now() < deadline) {
				const agentState = session.state.agents.get(entryAgentId)
				if (agentState?.status === 'paused') break
				await new Promise((r) => setTimeout(r, 10))
			}

			const agentState = session.state.agents.get(entryAgentId)!
			expect(agentState.status).toBe('paused')
			expect(agentState.pauseReason).toBe('handler')

			await harness.shutdown()
		})

		it('afterInference returning { action: "modify", response } → response replaced', async () => {
			const trackingPlugin = definePlugin('tracking')
				.hook('afterInference', async (ctx) => {
					// Modify the response to change content
					return {
						action: 'modify',
						response: {
							content: 'MODIFIED RESPONSE',
							toolCalls: ctx.response.toolCalls,
						},
					}
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Original response', toolCalls: [] }),
				systemPlugins: [trackingPlugin],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			// The conversation history should contain the modified response
			const entryAgentId = session.getEntryAgentId()!
			const agentState = session.state.agents.get(entryAgentId)!
			const lastAssistant = [...agentState.conversationHistory].reverse().find((m) => m.role === 'assistant')
			expect(lastAssistant).toBeDefined()
			expect(lastAssistant!.content).toBe('MODIFIED RESPONSE')

			await harness.shutdown()
		})

		it('beforeToolCall fires before tool execution and can see tool name and input', async () => {
			const captured: { toolName: string | null; input: unknown } = { toolName: null, input: null }

			const trackingPlugin = definePlugin('tracking')
				.hook('beforeToolCall', async (ctx) => {
					captured.toolName = ctx.toolCall.name
					captured.input = ctx.toolCall.input
					return null
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
					},
					{ content: 'Done', toolCalls: [] },
				]),
				systemPlugins: [trackingPlugin],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			expect(captured.toolName).toBe('tell_user')
			expect(captured.input).toEqual({ message: 'Hi!' })

			await harness.shutdown()
		})

		it('beforeToolCall returning { action: "block" } → tool not executed', async () => {
			const trackingPlugin = definePlugin('tracking')
				.hook('beforeToolCall', async () => {
					return { action: 'block', reason: 'Blocked by test' }
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
					},
					{ content: 'Done', toolCalls: [] },
				]),
				systemPlugins: [trackingPlugin],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			// Tool should have been blocked — no successful tool_completed, but a tool_failed with block message
			const toolCompleted = await session.getEventsByType(toolEvents, 'tool_completed')
			expect(toolCompleted).toHaveLength(0)

			const toolFailed = await session.getEventsByType(toolEvents, 'tool_failed')
			expect(toolFailed).toHaveLength(1)
			expect(toolFailed[0].error).toContain('Blocked by test')

			// No agent message notification since tool was blocked
			expect(harness.notifications.getAgentMessages()).toHaveLength(0)

			await harness.shutdown()
		})

		it('afterToolCall fires after tool execution and can see result', async () => {
			const captured: { toolName: string | null; isError: boolean | null } = { toolName: null, isError: null }

			const trackingPlugin = definePlugin('tracking')
				.hook('afterToolCall', async (ctx) => {
					captured.toolName = ctx.toolCall.name
					captured.isError = ctx.result.isError
					return null
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
					},
					{ content: 'Done', toolCalls: [] },
				]),
				systemPlugins: [trackingPlugin],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			expect(captured.toolName).toBe('tell_user')
			expect(captured.isError).toBe(false)

			await harness.shutdown()
		})

		it('afterToolCall returning { action: "modify", result } → result replaced', async () => {
			const trackingPlugin = definePlugin('tracking')
				.hook('afterToolCall', async () => {
					return {
						action: 'modify',
						result: { isError: false, content: 'MODIFIED TOOL RESULT' },
					}
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hi!' } }],
					},
					{ content: 'Done', toolCalls: [] },
				]),
				systemPlugins: [trackingPlugin],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			// The second LLM request should see the modified tool result
			const lastRequest = harness.llmProvider.getLastRequest()!
			const toolMessages = lastRequest.messages.filter((m) => m.role === 'tool')
			expect(toolMessages.length).toBeGreaterThanOrEqual(1)

			// The tool result content should be the modified one
			const toolMsg = toolMessages[0]
			expect(toolMsg.content).toBe('MODIFIED TOOL RESULT')

			await harness.shutdown()
		})

		it('onComplete fires when agent has no more work', async () => {
			const calls: string[] = []

			const trackingPlugin = definePlugin('tracking')
				.hook('onComplete', async () => {
					calls.push('onComplete')
					return null
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [trackingPlugin],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			expect(calls).toContain('onComplete')

			// onComplete with null result no longer emits handler_completed (pure noise);
			// hook invocation is verified via the `calls` array above.

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Session hooks
	// =========================================================================

	describe('session hooks', () => {
		it('onSessionReady fires after session creation', async () => {
			const calls: string[] = []

			const trackingPlugin = definePlugin('tracking')
				.sessionHook('onSessionReady', async () => {
					calls.push('onSessionReady')
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [trackingPlugin],
			})

			await harness.createSession('test')

			expect(calls).toContain('onSessionReady')

			await harness.shutdown()
		})

		it('onSessionClose fires when session closes', async () => {
			const calls: string[] = []

			const trackingPlugin = definePlugin('tracking')
				.sessionHook('onSessionClose', async () => {
					calls.push('onSessionClose')
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [trackingPlugin],
			})

			const session = await harness.createSession('test')
			await session.close()

			expect(calls).toContain('onSessionClose')

			await harness.shutdown()
		})

		it('onSessionClose fires on manager shutdown, without closing the session', async () => {
			const calls: string[] = []

			const trackingPlugin = definePlugin('tracking')
				.sessionHook('onSessionClose', async () => {
					calls.push('onSessionClose')
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [trackingPlugin],
			})

			const session = await harness.createSession('test')
			await harness.shutdown()

			// Plugins must get to release their resources when the host goes away
			expect(calls).toEqual(['onSessionClose'])

			// ...but the session itself is not closed — nothing is written to the log
			const closedEvents = await harness.eventStore.getEventsByType(session.sessionId, 'session_closed')
			expect(closedEvents).toHaveLength(0)

			const metadata = await harness.eventStore.getMetadata(session.sessionId)
			expect(metadata?.status).toBe('active')
		})

		it('onSessionClose runs once when a closed session is shut down', async () => {
			const calls: string[] = []

			const trackingPlugin = definePlugin('tracking')
				.sessionHook('onSessionClose', async () => {
					calls.push('onSessionClose')
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [trackingPlugin],
			})

			const session = await harness.createSession('test')
			await session.close()
			await harness.shutdown()

			expect(calls).toEqual(['onSessionClose'])
		})

		describe('beforeMethod', () => {
			it('returning { action: "deny" } → method call rejected and handler not run', async () => {
				let handlerCalls = 0
				const seenMethods: string[] = []

				const gatedPlugin = definePlugin('gated')
					.method('blocked', {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						handler: async () => {
							handlerCalls++
							return Ok({ ok: true })
						},
					})
					.sessionHook('beforeMethod', async (ctx) => {
						seenMethods.push(ctx.method)
						if (ctx.method === 'gated.blocked') {
							return { action: 'deny', reason: 'blocked by test' }
						}
						return null
					})
					.build()

				const harness = new TestHarness({
					presets: [createTestPreset()],
					llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
					systemPlugins: [gatedPlugin],
				})

				const session = await harness.createSession('test')
				const result = await session.callPluginMethod('gated.blocked', {})

				expect(result.ok).toBe(false)
				if (!result.ok) {
					expect(result.error.type).toBe('method_denied')
					expect(result.error.message).toBe('blocked by test')
				}
				expect(handlerCalls).toBe(0)
				expect(seenMethods).toContain('gated.blocked')

				await harness.shutdown()
			})

			it('returning null → method call proceeds to the handler', async () => {
				let handlerCalls = 0

				const gatedPlugin = definePlugin('gated')
					.method('allowed', {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						handler: async () => {
							handlerCalls++
							return Ok({ ok: true })
						},
					})
					.sessionHook('beforeMethod', async () => null)
					.build()

				const harness = new TestHarness({
					presets: [createTestPreset()],
					llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
					systemPlugins: [gatedPlugin],
				})

				const session = await harness.createSession('test')
				const result = await session.callPluginMethod('gated.allowed', {})

				expect(result.ok).toBe(true)
				expect(handlerCalls).toBe(1)

				await harness.shutdown()
			})
		})
	})

	// =========================================================================
	// Hook ordering
	// =========================================================================

	describe('hook ordering', () => {
		it('multiple plugins with same hook → all fire in registration order', async () => {
			const order: string[] = []

			const pluginA = definePlugin('plugin-a')
				.hook('onStart', async () => {
					order.push('A')
					return null
				})
				.build()

			const pluginB = definePlugin('plugin-b')
				.hook('onStart', async () => {
					order.push('B')
					return null
				})
				.build()

			const pluginC = definePlugin('plugin-c')
				.hook('onStart', async () => {
					order.push('C')
					return null
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [pluginA, pluginB, pluginC],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello')

			// All three plugins should have fired
			expect(order).toContain('A')
			expect(order).toContain('B')
			expect(order).toContain('C')

			// They should be in registration order
			expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'))
			expect(order.indexOf('B')).toBeLessThan(order.indexOf('C'))

			await harness.shutdown()
		})
	})

	// =========================================================================
	// beforeDequeue gate
	// =========================================================================

	describe('beforeDequeue', () => {
		it('holding a source → messages do not wake the agent, and are re-delivered (not dropped) once released', async () => {
			let holding = true

			const gatePlugin = definePlugin('budget-gate')
				.beforeDequeue((ctx) => {
					if (holding && ctx.sourcePlugin === 'user-chat') {
						return { action: 'hold' }
					}
					return null
				})
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [gatePlugin],
			})

			const session = await harness.createSession('test')

			// Held: the user message is queued but must not trigger an inference.
			await session.sendMessage('first')
			await new Promise((r) => setTimeout(r, 50))
			expect(harness.llmProvider.getLastRequest()).toBeUndefined()

			// Released: a new message wakes the agent; the held 'first' must be
			// re-delivered alongside 'second' (held, not dropped).
			holding = false
			await session.sendAndWaitForIdle('second')

			const req = harness.llmProvider.getLastRequest()
			expect(req).toBeDefined()
			const serialized = JSON.stringify(req!.messages)
			expect(serialized).toContain('first')
			expect(serialized).toContain('second')

			await harness.shutdown()
		})

		it('returning null → messages flow through normally', async () => {
			const gatePlugin = definePlugin('budget-gate')
				.beforeDequeue(() => null)
				.build()

			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
				systemPlugins: [gatePlugin],
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('hello')

			expect(harness.llmProvider.getLastRequest()).toBeDefined()

			await harness.shutdown()
		})
	})
})
