import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { userChatEvents, userChatPlugin } from './index.js'
import type { UserChatState } from './plugin.js'
import { ChatMessageId } from './schema.js'

const waitUntilAsync = async (
	predicate: () => Promise<boolean>,
	timeoutMs = 1_000,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
		await Bun.sleep(5)
	}
}

describe('user-chat plugin', () => {
	// =========================================================================
	// sendMessage flow
	// =========================================================================

	describe('sendMessage flow', () => {
		it('sendMessage → agent scheduled → LLM called with user message content', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hello world')

			const lastRequest = harness.llmProvider.getLastRequest()
			expect(lastRequest).toBeDefined()
			const lastMessage = lastRequest!.messages[lastRequest!.messages.length - 1]
			expect(lastMessage.content).toContain('Hello world')

			await harness.shutdown()
		})

		it('sendMessage → user_chat_message_received event emitted', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Test message')

			const events = await session.getEventsByType('user_chat_message_received')
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'user_chat_message_received',
				content: 'Test message',
			})

			await harness.shutdown()
		})

		it('sendMessage to specific agent (non-entry) via sendMessageToAgent', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()!
			await session.sendMessageToAgent(entryAgentId, 'Direct message')
			await session.waitForIdle()

			const events = await session.getEventsByType('user_chat_message_received')
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				agentId: entryAgentId,
				content: 'Direct message',
			})

			await harness.shutdown()
		})

		it('multiple sendMessage calls → all messages appear in conversation history in order', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('First message')
			await session.sendAndWaitForIdle('Second message')

			const events = await session.getEventsByType('user_chat_message_received')
			expect(events).toHaveLength(2)
			expect(events[0]).toMatchObject({ content: 'First message' })
			expect(events[1]).toMatchObject({ content: 'Second message' })

			await harness.shutdown()
		})

		it('sendMessage → consumed inbound payload is pruned while UI history remains', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Test')

			// Check consumed event was emitted
			const consumedEvents = await session.getEventsByType('user_chat_messages_consumed')
			expect(consumedEvents.length).toBeGreaterThanOrEqual(1)

			const state = selectPluginState<UserChatState>(session.state, 'messages')
			expect(state?.pendingInbound).toHaveLength(0)
			expect(state?.messages).toContainEqual(expect.objectContaining({
				type: 'user_message',
				content: 'Test',
			}))

			await harness.shutdown()
		})

		it('pending inbound keeps only a reference to canonical UI content', async () => {
			let releaseInference: (() => void) | undefined
			const inferenceGate = new Promise<void>((resolve) => {
				releaseInference = resolve
			})
			const harness = new TestHarness({
				presets: [createTestPreset()],
				mockHandler: async () => {
					await inferenceGate
					return {
						content: 'Done',
						toolCalls: [],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				},
			})

			const session = await harness.createSession('test')
			await session.sendMessage('Canonical payload')

			const pendingState = selectPluginState<UserChatState>(session.state, 'messages')
			expect(pendingState?.pendingInbound).toHaveLength(1)
			expect(pendingState?.pendingInbound[0]).not.toHaveProperty('content')
			expect(pendingState?.messages).toContainEqual(expect.objectContaining({
				type: 'user_message',
				content: 'Canonical payload',
			}))

			releaseInference?.()
			await session.waitForIdle()
			expect(selectPluginState<UserChatState>(session.state, 'messages')?.pendingInbound).toHaveLength(0)

			await harness.shutdown()
		})

		it('concurrent sends allocate unique IDs and deliver immutable content once', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})
			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.pauseAgent(entryAgentId, 'Inspect pending input')

			const [first, second] = await Promise.all([
				session.callPluginMethod('user-chat.sendMessage', {
					agentId: String(entryAgentId),
					content: 'Concurrent A',
				}),
				session.callPluginMethod('user-chat.sendMessage', {
					agentId: String(entryAgentId),
					content: 'Concurrent B',
				}),
			])
			expect(first.ok).toBe(true)
			expect(second.ok).toBe(true)

			const pendingState = selectPluginState<UserChatState>(session.state, 'messages')
			expect(pendingState?.pendingInbound.map((message) => message.messageId).sort()).toEqual([
				ChatMessageId('m1'),
				ChatMessageId('m2'),
			])
			expect(pendingState?.messages.filter((message) => message.type === 'user_message')).toEqual([
				expect.objectContaining({ messageId: ChatMessageId('m1'), content: 'Concurrent A' }),
				expect.objectContaining({ messageId: ChatMessageId('m2'), content: 'Concurrent B' }),
			])

			await session.resumeAgent(entryAgentId)
			await session.waitForIdle()
			const requestText = harness.llmProvider.getCallHistory().flatMap((request) =>
				request.messages.map((message) =>
					typeof message.content === 'string' ? message.content : '',
				),
			).join('\n')
			expect(requestText.split('Concurrent A')).toHaveLength(2)
			expect(requestText.split('Concurrent B')).toHaveLength(2)

			await harness.shutdown()
		})

		it('retryable provider failure preserves pending input until recovery', async () => {
			let inferenceCount = 0
			const seenContent: string[] = []
			const preset = createTestPreset()
			preset.orchestrator.errorResumeBackoff = { baseDelayMs: 250, maxDelayMs: 250 }
			const harness = new TestHarness({
				presets: [preset],
				mockHandler: (request) => {
					inferenceCount++
					seenContent.push(request.messages.map((message) =>
						typeof message.content === 'string' ? message.content : '',
					).join('\n'))
					if (inferenceCount <= 5) {
						throw { type: 'server_error', message: 'temporary outage', retryAfterMs: 0 }
					}
					return {
						content: 'Recovered',
						toolCalls: [],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				},
			})

			const session = await harness.createSession('test')
			await session.sendMessage('Retry payload')
			await waitUntilAsync(async () =>
				(await session.getEventsByType('inference_failed')).length === 1,
			)

			const failedState = selectPluginState<UserChatState>(session.state, 'messages')
			expect(failedState?.pendingInbound).toHaveLength(1)
			expect(await session.getEventsByType('user_chat_messages_consumed')).toHaveLength(0)

			await session.waitForIdle({ timeoutMs: 5_000 })
			expect(inferenceCount).toBe(6)
			expect(seenContent[0]).toContain('Retry payload')
			expect(seenContent[5]).toContain('Retry payload')
			expect(selectPluginState<UserChatState>(session.state, 'messages')?.pendingInbound).toHaveLength(0)

			await harness.shutdown()
		})

		it('consumption replay preserves UI history without rebuilding pending work', async () => {
			const firstHarness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})
			const firstSession = await firstHarness.createSession('test')
			await firstSession.sendAndWaitForIdle('Persisted UI message')
			const sessionId = firstSession.sessionId
			const eventStore = firstHarness.eventStore
			await firstHarness.shutdown()

			const secondHarness = new TestHarness({
				presets: [createTestPreset()],
				eventStore,
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})
			const replayedSession = await secondHarness.openSession(sessionId)
			const replayedState = selectPluginState<UserChatState>(replayedSession.state, 'messages')
			expect(replayedState?.pendingInbound).toHaveLength(0)
			expect(replayedState?.messages).toContainEqual(expect.objectContaining({
				type: 'user_message',
				content: 'Persisted UI message',
			}))

			await secondHarness.shutdown()
		})

		it('replays duplicate message IDs as distinct ordered occurrences', async () => {
			const firstHarness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})
			const firstSession = await firstHarness.createSession('test')
			const sessionId = firstSession.sessionId
			const entryAgentId = firstSession.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			const eventStore = firstHarness.eventStore
			await firstHarness.shutdown()

			await eventStore.appendBatch(sessionId, [
				withSessionId(sessionId, userChatEvents.create('user_chat_message_received', {
					agentId: entryAgentId,
					messageId: ChatMessageId('m1'),
					content: 'Duplicate A',
					timestamp: 1,
				})),
				withSessionId(sessionId, userChatEvents.create('user_chat_message_received', {
					agentId: entryAgentId,
					messageId: ChatMessageId('m1'),
					content: 'Duplicate B',
					timestamp: 2,
				})),
			])

			const secondHarness = new TestHarness({
				presets: [createTestPreset()],
				eventStore,
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})
			const replayedSession = await secondHarness.openSession(sessionId)
			await replayedSession.waitForIdle()
			const requestText = secondHarness.llmProvider.getCallHistory().flatMap((request) =>
				request.messages.map((message) =>
					typeof message.content === 'string' ? message.content : '',
				),
			).join('\n')
			const firstIndex = requestText.indexOf('Duplicate A')
			const secondIndex = requestText.indexOf('Duplicate B')
			expect(firstIndex).toBeGreaterThanOrEqual(0)
			expect(secondIndex).toBeGreaterThan(firstIndex)
			expect(requestText.split('Duplicate A')).toHaveLength(2)
			expect(requestText.split('Duplicate B')).toHaveLength(2)
			const consumed = await replayedSession.getEventsByType(
				userChatEvents,
				'user_chat_messages_consumed',
			)
			expect(consumed.at(-1)?.messageIds).toEqual([
				ChatMessageId('m1'),
				ChatMessageId('m1'),
			])
			expect(consumed.at(-1)?.ordinals).toEqual([1, 2])

			await secondHarness.shutdown()
		})

		it('legacy consumption removes only the targeted duplicate occurrence and agent', async () => {
			const firstHarness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})
			const firstSession = await firstHarness.createSession('test')
			const sessionId = firstSession.sessionId
			const entryAgentId = firstSession.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await firstSession.pauseAgent(entryAgentId, 'Inspect replay')
			const otherAgentId = AgentId('other_1')
			const eventStore = firstHarness.eventStore
			await firstHarness.shutdown()

			await eventStore.appendBatch(sessionId, [
				withSessionId(sessionId, userChatEvents.create('user_chat_message_received', {
					agentId: entryAgentId,
					messageId: ChatMessageId('m1'),
					content: 'Already consumed',
					timestamp: 1,
				})),
				withSessionId(sessionId, userChatEvents.create('user_chat_message_received', {
					agentId: otherAgentId,
					messageId: ChatMessageId('m1'),
					content: 'Other agent pending',
					timestamp: 2,
				})),
				withSessionId(sessionId, userChatEvents.create('user_chat_messages_consumed', {
					agentId: entryAgentId,
					messageIds: [ChatMessageId('m1')],
				})),
				withSessionId(sessionId, userChatEvents.create('user_chat_message_received', {
					agentId: entryAgentId,
					messageId: ChatMessageId('m1'),
					content: 'Later duplicate',
					timestamp: 3,
				})),
			])

			const secondHarness = new TestHarness({
				presets: [createTestPreset()],
				eventStore,
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})
			const replayedSession = await secondHarness.openSession(sessionId)
			const replayedState = selectPluginState<UserChatState>(replayedSession.state, 'messages')
			const entryPending = replayedState?.pendingInbound.filter(
				(message) => message.agentId === entryAgentId,
			) ?? []
			const otherPending = replayedState?.pendingInbound.filter(
				(message) => message.agentId === otherAgentId,
			) ?? []
			expect(entryPending.map((message) => message.ordinal)).toEqual([3])
			expect(otherPending.map((message) => message.ordinal)).toEqual([2])

			await replayedSession.resumeAgent(entryAgentId)
			await replayedSession.waitForIdle()
			const requestText = secondHarness.llmProvider.getCallHistory().flatMap((request) =>
				request.messages.map((message) =>
					typeof message.content === 'string' ? message.content : '',
				),
			).join('\n')
			expect(requestText).toContain('Later duplicate')
			expect(requestText).not.toContain('Already consumed')
			expect(selectPluginState<UserChatState>(replayedSession.state, 'messages')?.pendingInbound).toEqual([
				expect.objectContaining({ ordinal: 2, agentId: otherAgentId }),
			])

			await secondHarness.shutdown()
		})

		it('replays each immutable answer value, including an orphaned legacy answer', async () => {
			const firstHarness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})
			const firstSession = await firstHarness.createSession('test')
			const sessionId = firstSession.sessionId
			const entryAgentId = firstSession.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			const eventStore = firstHarness.eventStore
			await firstHarness.shutdown()

			await eventStore.appendBatch(sessionId, [
				withSessionId(sessionId, userChatEvents.create('user_question_asked', {
					agentId: entryAgentId,
					messageId: ChatMessageId('m10'),
					question: 'Choose once',
					inputType: { type: 'text' },
				})),
				withSessionId(sessionId, userChatEvents.create('user_chat_answer_received', {
					agentId: entryAgentId,
					messageId: ChatMessageId('m11'),
					questionId: ChatMessageId('m10'),
					answerValue: 'first answer',
					timestamp: 11,
				})),
				withSessionId(sessionId, userChatEvents.create('user_chat_answer_received', {
					agentId: entryAgentId,
					messageId: ChatMessageId('m11'),
					questionId: ChatMessageId('m10'),
					answerValue: 'second answer',
					timestamp: 12,
				})),
				withSessionId(sessionId, userChatEvents.create('user_chat_answer_received', {
					agentId: entryAgentId,
					messageId: ChatMessageId('m12'),
					questionId: ChatMessageId('missing-question'),
					answerValue: 'orphan answer',
					timestamp: 13,
				})),
			])

			const secondHarness = new TestHarness({
				presets: [createTestPreset()],
				eventStore,
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})
			const replayedSession = await secondHarness.openSession(sessionId)
			await replayedSession.waitForIdle()
			const requestText = secondHarness.llmProvider.getCallHistory().flatMap((request) =>
				request.messages.map((message) =>
					typeof message.content === 'string' ? message.content : '',
				),
			).join('\n')
			const firstIndex = requestText.indexOf('first answer')
			const secondIndex = requestText.indexOf('second answer')
			expect(firstIndex).toBeGreaterThanOrEqual(0)
			expect(secondIndex).toBeGreaterThan(firstIndex)
			expect(requestText).toContain('orphan answer')

			const replayedState = selectPluginState<UserChatState>(replayedSession.state, 'messages')
			const question = replayedState?.messages.find((message) => message.type === 'ask_user')
			expect(question).toEqual(expect.objectContaining({ answered: true, answer: 'second answer' }))
			expect(replayedState?.pendingInbound).toHaveLength(0)
			expect(replayedState?.pendingAnswers?.size).toBe(0)

			await secondHarness.shutdown()
		})
	})

	// =========================================================================
	// tell_user tool
	// =========================================================================

	describe('tell_user tool', () => {
		it('agent calls tell_user → agentMessage notification emitted', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hello user!' } }],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const messages = harness.notifications.getAgentMessages()
			expect(messages).toHaveLength(1)
			expect(messages[0].content).toBe('Hello user!')

			await harness.shutdown()
		})

		it('tell_user with format: text → notification has text format', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Plain text', format: 'text' } }],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const messages = harness.notifications.getAgentMessages()
			expect(messages).toHaveLength(1)
			expect(messages[0].format).toBe('text')

			await harness.shutdown()
		})

		it('tell_user with format: markdown → notification has markdown format', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: '**Bold**', format: 'markdown' } }],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const messages = harness.notifications.getAgentMessages()
			expect(messages).toHaveLength(1)
			expect(messages[0].format).toBe('markdown')

			await harness.shutdown()
		})

		it('tell_user → user_message_sent event emitted with correct content', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Event test' } }],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const events = await session.getEventsByType('user_message_sent')
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'user_message_sent',
				message: 'Event test',
			})

			await harness.shutdown()
		})

		it('tell_user → message appears in getMessages result', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Stored msg' } }],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const chatMessages = selectPluginState<UserChatState>(session.state, 'messages')?.messages ?? []
			const agentMessages = chatMessages.filter((m) => m.type === 'agent_message')
			expect(agentMessages).toHaveLength(1)
			expect(agentMessages[0]).toMatchObject({
				type: 'agent_message',
				content: 'Stored msg',
			})

			await harness.shutdown()
		})
	})

	// =========================================================================
	// ask_user tool
	// =========================================================================

	describe('ask_user tool', () => {
		it('agent calls ask_user (text input) → askUser notification emitted with question', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'ask_user',
							input: { question: 'What is your name?', inputType: 'text' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const askNotifications = harness.notifications.getByType('user-chat', 'askUser')
			expect(askNotifications).toHaveLength(1)
			expect(askNotifications[0].payload).toMatchObject({
				question: 'What is your name?',
				inputType: { type: 'text' },
			})

			await harness.shutdown()
		})

		it('ask_user → user_question_asked event emitted', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'ask_user',
							input: { question: 'Confirm?', inputType: 'confirm' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const events = await session.getEventsByType('user_question_asked')
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'user_question_asked',
				question: 'Confirm?',
			})

			await harness.shutdown()
		})

		it('ask_user with single_choice → notification contains options', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'ask_user',
							input: {
								question: 'Pick one',
								inputType: 'single_choice',
								options: [
									{ value: 'a', label: 'Option A' },
									{ value: 'b', label: 'Option B' },
								],
							},
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const askNotifications = harness.notifications.getByType('user-chat', 'askUser')
			expect(askNotifications).toHaveLength(1)
			expect(askNotifications[0].payload).toMatchObject({
				inputType: {
					type: 'single_choice',
					options: [
						{ value: 'a', label: 'Option A' },
						{ value: 'b', label: 'Option B' },
					],
				},
			})

			await harness.shutdown()
		})

		it('ask_user with multi_choice → notification contains options', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'ask_user',
							input: {
								question: 'Pick multiple',
								inputType: 'multi_choice',
								options: [
									{ value: 'x', label: 'X' },
									{ value: 'y', label: 'Y' },
								],
							},
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const askNotifications = harness.notifications.getByType('user-chat', 'askUser')
			expect(askNotifications).toHaveLength(1)
			expect(askNotifications[0].payload).toMatchObject({
				inputType: {
					type: 'multi_choice',
					options: [
						{ value: 'x', label: 'X' },
						{ value: 'y', label: 'Y' },
					],
				},
			})

			await harness.shutdown()
		})

		it('ask_user with confirm → notification has confirm type', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'ask_user',
							input: { question: 'Are you sure?', inputType: 'confirm' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const askNotifications = harness.notifications.getByType('user-chat', 'askUser')
			expect(askNotifications).toHaveLength(1)
			expect(askNotifications[0].payload).toMatchObject({
				inputType: { type: 'confirm' },
			})

			await harness.shutdown()
		})

		it('ask_user with rating → notification has min/max', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'ask_user',
							input: { question: 'Rate this', inputType: 'rating', min: 1, max: 10 },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const askNotifications = harness.notifications.getByType('user-chat', 'askUser')
			expect(askNotifications).toHaveLength(1)
			expect(askNotifications[0].payload).toMatchObject({
				inputType: { type: 'rating', min: 1, max: 10 },
			})

			await harness.shutdown()
		})

		it('answerQuestion → answer delivered → agent sees answer in next inference', async () => {
			let inferenceCount = 0
			const harness = new TestHarness({
				presets: [createTestPreset()],
				mockHandler: (request) => {
					inferenceCount++
					if (inferenceCount === 1) {
						return {
							content: null,
							toolCalls: [{
								id: ToolCallId('tc1'),
								name: 'ask_user',
								input: { question: 'Your name?', inputType: 'text' },
							}],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					if (inferenceCount === 2) {
						// After tool result — agent finishes this cycle
						return {
							content: 'Waiting for answer',
							toolCalls: [],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					// After answer arrives — check the LLM sees it
					const lastMessage = request.messages[request.messages.length - 1]
					const content = typeof lastMessage.content === 'string' ? lastMessage.content : ''
					return {
						content: `Got: ${content}`,
						toolCalls: [],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			// Find the question event to get the questionId
			const questionEvents = await session.getEventsByType(userChatEvents, 'user_question_asked')
			expect(questionEvents).toHaveLength(1)
			const questionId = questionEvents[0].messageId
			const entryAgentId = session.getEntryAgentId()!

			// Answer the question via the new helper
			await session.answerQuestion(entryAgentId, questionId, 'John')
			await session.waitForIdle()

			// Verify the answer event was emitted
			const answerEvents = await session.getEventsByType('user_chat_answer_received')
			expect(answerEvents).toHaveLength(1)
			expect(answerEvents[0]).toMatchObject({
				answerValue: 'John',
			})

			// Verify LLM saw the answer (inference count should be > 2)
			expect(inferenceCount).toBeGreaterThan(2)

			await harness.shutdown()
		})

		it('answerQuestion → user_chat_answer_received event emitted', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'ask_user',
							input: { question: 'Color?', inputType: 'text' },
						}],
					},
					{ content: 'Waiting', toolCalls: [] },
					{ content: 'Got it', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const questionEvents = await session.getEventsByType(userChatEvents, 'user_question_asked')
			const questionId = questionEvents[0].messageId
			const entryAgentId = session.getEntryAgentId()!

			await session.answerQuestion(entryAgentId, questionId, 'Blue')
			await session.waitForIdle()

			const answerEvents = await session.getEventsByType('user_chat_answer_received')
			expect(answerEvents).toHaveLength(1)
			expect(answerEvents[0]).toMatchObject({
				type: 'user_chat_answer_received',
				answerValue: 'Blue',
				questionId,
			})

			await harness.shutdown()
		})

		it('answerQuestion → question marked as answered in getMessages', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'ask_user',
							input: { question: 'Ready?', inputType: 'confirm' },
						}],
					},
					{ content: 'Waiting', toolCalls: [] },
					{ content: 'Great', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const questionEvents = await session.getEventsByType(userChatEvents, 'user_question_asked')
			const questionId = questionEvents[0].messageId
			const entryAgentId = session.getEntryAgentId()!

			await session.answerQuestion(entryAgentId, questionId, true)
			await session.waitForIdle()

			// Check messages state
			const chatMessages = selectPluginState<UserChatState>(session.state, 'messages')?.messages ?? []
			const askMessages = chatMessages.filter((m) => m.type === 'ask_user')
			expect(askMessages).toHaveLength(1)
			expect(askMessages[0]).toMatchObject({
				type: 'ask_user',
				answered: true,
				answer: true,
			})
			expect(selectPluginState<UserChatState>(session.state, 'messages')?.pendingInbound).toHaveLength(0)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// Unicode escape decoding (defensive fix for models that double-escape
	// non-ASCII in tool argument JSON — see plugin.ts decodeUnicodeEscapes).
	// =========================================================================

	describe('unicode escape decoding in user-facing fields', () => {
		it('ask_user (text) → literal \\uXXXX in question/placeholder is decoded', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'ask_user',
							input: {
								question: 'Pro\\u010d ne?',
								inputType: 'text',
								placeholder: 'Nap\\u0159. ano',
							},
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const askNotifications = harness.notifications.getByType('user-chat', 'askUser')
			expect(askNotifications[0].payload).toMatchObject({
				question: 'Proč ne?',
				inputType: { type: 'text', placeholder: 'Např. ano' },
			})

			await harness.shutdown()
		})

		it('ask_user (single_choice) → option labels decoded, values left intact', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'ask_user',
							input: {
								question: 'Pick',
								inputType: 'single_choice',
								options: [
									{ value: 'kun_ze_\\u0159adu', label: 'K\\u016f\\u0148 ze \\u0159adu' },
								],
							},
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const askNotifications = harness.notifications.getByType('user-chat', 'askUser')
			expect(askNotifications[0].payload).toMatchObject({
				inputType: {
					type: 'single_choice',
					// Value preserved verbatim so answer round-trip stays consistent
					// with what the LLM emitted.
					options: [{ value: 'kun_ze_\\u0159adu', label: 'Kůň ze řadu' }],
				},
			})

			await harness.shutdown()
		})

		it('tell_user → literal \\uXXXX in message is decoded', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'tell_user',
							input: { message: 'Ahoj sv\\u011bte' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const msgs = harness.notifications.getByType('user-chat', 'agentMessage')
			expect(msgs[0].payload).toMatchObject({ content: 'Ahoj světe' })

			await harness.shutdown()
		})
	})

	// =========================================================================
	// XML mode
	// =========================================================================

	describe('XML mode', () => {
		it('agent with userCommunication: xml → <user> tags parsed from response → notification emitted', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset({
					orchestratorPlugins: [
						userChatPlugin.configureAgent({ enabled: true, userCommunication: 'xml' }),
					],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({
					content: 'Thinking... <user>Hello from XML!</user> Done.',
					toolCalls: [],
				}),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const messages = harness.notifications.getAgentMessages()
			expect(messages).toHaveLength(1)
			expect(messages[0].content).toBe('Hello from XML!')

			await harness.shutdown()
		})

		it('<user> tags stripped from response content after parsing', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset({
					orchestratorPlugins: [
						userChatPlugin.configureAgent({ enabled: true, userCommunication: 'xml' }),
					],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({
					content: 'Before <user>Message</user> After',
					toolCalls: [],
				}),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			// The user_message_sent event should have the extracted message
			const events = await session.getEventsByType('user_message_sent')
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ message: 'Message' })

			await harness.shutdown()
		})

		it('agent with userCommunication: both → both tools and <user> tags work', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset({
					orchestratorPlugins: [
						userChatPlugin.configureAgent({ enabled: true, userCommunication: 'both' }),
					],
				})],
				llmProvider: MockLLMProvider.withSequence([
					{
						content: 'Thinking... <user>XML message!</user> Done.',
						toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Tool message!' } }],
					},
					{ content: 'Finished', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const messages = harness.notifications.getAgentMessages()
			expect(messages).toHaveLength(2)
			const contents = messages.map((m) => m.content)
			expect(contents).toContain('Tool message!')
			expect(contents).toContain('XML message!')

			await harness.shutdown()
		})

		it('agent with userCommunication: tool (default) → <user> tags ignored', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({
					content: 'Response with <user>Should not be parsed</user> content',
					toolCalls: [],
				}),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const messages = harness.notifications.getAgentMessages()
			expect(messages).toHaveLength(0)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// getMessages
	// =========================================================================

	describe('getMessages', () => {
		it('getMessages returns all chat messages (user + agent + ask_user) in order', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [
							{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'Hello!' } },
							{ id: ToolCallId('tc2'), name: 'ask_user', input: { question: 'Name?', inputType: 'text' } },
						],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const chatMessages = selectPluginState<UserChatState>(session.state, 'messages')?.messages ?? []
			// Should have: user_message (from sendMessage), agent_message (from tell_user), ask_user (from ask_user)
			expect(chatMessages.length).toBeGreaterThanOrEqual(3)

			const types = chatMessages.map((m) => m.type)
			expect(types).toContain('user_message')
			expect(types).toContain('agent_message')
			expect(types).toContain('ask_user')

			await harness.shutdown()
		})

		it('getMessages reflects answered questions', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'ask_user',
							input: { question: 'Favorite color?', inputType: 'text' },
						}],
					},
					{ content: 'Waiting', toolCalls: [] },
					{ content: 'Got it', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			// Before answering — question should be unanswered
			const beforeMessages = selectPluginState<UserChatState>(session.state, 'messages')?.messages ?? []
			const beforeAsk = beforeMessages.filter((m) => m.type === 'ask_user')
			expect(beforeAsk).toHaveLength(1)
			expect(beforeAsk[0]).toMatchObject({ answered: false })
			expect(beforeAsk[0]).not.toHaveProperty('answer')

			// Answer the question
			const questionEvents = await session.getEventsByType(userChatEvents, 'user_question_asked')
			const questionId = questionEvents[0].messageId
			const entryAgentId = session.getEntryAgentId()!

			await session.answerQuestion(entryAgentId, questionId, 'Blue')
			await session.waitForIdle()

			// After answering — question should be marked as answered with answer value
			const afterMessages = selectPluginState<UserChatState>(session.state, 'messages')?.messages ?? []
			const afterAsk = afterMessages.filter((m) => m.type === 'ask_user')
			expect(afterAsk).toHaveLength(1)
			expect(afterAsk[0]).toMatchObject({
				answered: true,
				answer: 'Blue',
			})

			await harness.shutdown()
		})
	})

	// =========================================================================
	// disabled
	// =========================================================================

	describe('disabled', () => {
		it('plugin enabled: false → no tools provided to agent', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset({
					plugins: [
						userChatPlugin.configure({ enabled: false }),
					],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const lastRequest = harness.llmProvider.getLastRequest()
			const toolNames = lastRequest?.tools?.map((t) => t.name) ?? []
			expect(toolNames).not.toContain('tell_user')
			expect(toolNames).not.toContain('ask_user')

			await harness.shutdown()
		})

		it('agent enabled: false → no user-chat tools provided to that agent', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset({
					orchestratorPlugins: [
						userChatPlugin.configureAgent({ enabled: false }),
					],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const lastRequest = harness.llmProvider.getLastRequest()
			const toolNames = lastRequest?.tools?.map((t) => t.name) ?? []
			expect(toolNames).not.toContain('tell_user')
			expect(toolNames).not.toContain('ask_user')

			await harness.shutdown()
		})
	})
})
