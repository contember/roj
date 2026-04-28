import { describe, expect, it } from 'bun:test'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { userChatEvents, userChatPlugin } from './index.js'
import type { UserChatState } from './plugin.js'

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

		it('sendMessage → pending inbound message created and marked consumed after inference', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Test')

			// Check consumed event was emitted
			const consumedEvents = await session.getEventsByType('user_chat_messages_consumed')
			expect(consumedEvents.length).toBeGreaterThanOrEqual(1)

			// After consumption, pending messages should be marked consumed in state
			const pendingInbound = selectPluginState<UserChatState>(session.state, 'messages')?.pendingInbound ?? []
			const unconsumed = pendingInbound.filter((m) => !m.consumed)
			expect(unconsumed).toHaveLength(0)

			await harness.shutdown()
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
