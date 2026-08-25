import { describe, expect, it } from 'bun:test'
import { AgentId } from '~/core/agents/schema.js'
import { MemoryEventStore } from '~/core/events/memory.js'
import { withSessionId } from '~/core/events/test-helpers.js'
import type { DomainEvent } from '~/core/events/types.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { UploadId } from '~/plugins/uploads/schema.js'
import { createMultiAgentPreset, createTestPreset, TestHarness } from '~/testing/index.js'
import { getAgentMailbox, getAgentUnconsumedMailbox, mailboxEvents, MessageId, selectMailboxState } from './index.js'

class InterleavedMailboxEventStore extends MemoryEventStore {
	readonly secondMailboxAppendStarted = Promise.withResolvers<void>()
	readonly releaseSecondMailboxAppend = Promise.withResolvers<void>()
	private mailboxAppendCount = 0

	protected override async doAppend(sessionId: SessionId, event: DomainEvent): Promise<void> {
		if (event.type === 'mailbox_message') {
			this.mailboxAppendCount++
			if (this.mailboxAppendCount === 2) {
				this.secondMailboxAppendStarted.resolve()
				await this.releaseSecondMailboxAppend.promise
			}
		}
		await super.doAppend(sessionId, event)
	}
}

const waitUntil = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
		await Bun.sleep(5)
	}
}

describe('mailbox plugin', () => {
	// =========================================================================
	// send_message tool
	// =========================================================================

	describe('send_message tool', () => {
		it('send_message with to: parent → parent receives message in dequeue', async () => {
			let orchestratorCalls = 0
			let workerCalls = 0
			let orchestratorSawWorkerMessage = false

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Do some work' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						const lastMsg = request.messages[request.messages.length - 1]
						if (typeof lastMsg?.content === 'string' && lastMsg.content.includes('Hello from worker')) {
							orchestratorSawWorkerMessage = true
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					workerCalls++
					if (workerCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc2'), name: 'send_message', input: { to: 'parent', message: 'Hello from worker' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			expect(orchestratorSawWorkerMessage).toBe(true)

			const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			const workerToParent = events.filter(e => e.message.content === 'Hello from worker')
			expect(workerToParent).toHaveLength(1)
			expect(workerToParent[0].toAgentId).toBe(session.getEntryAgentId()!)

			await harness.shutdown()
		})

		it('send_message with to: childAgentId → child receives message in dequeue', async () => {
			let orchestratorCalls = 0
			let workerSawExtraMessage = false

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Initial task' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						if (orchestratorCalls === 2) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc2'), name: 'send_message', input: { to: 'worker_1', message: 'Extra task for you' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					if (request.messages.some(m => typeof m.content === 'string' && m.content.includes('Extra task for you'))) {
						workerSawExtraMessage = true
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			expect(workerSawExtraMessage).toBe(true)

			const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			const orchToWorker = events.filter(e => e.message.content === 'Extra task for you')
			expect(orchToWorker).toHaveLength(1)
			expect(orchToWorker[0].toAgentId).toBe(AgentId('worker_1'))

			await harness.shutdown()
		})

		it('send_message to invalid target → tool returns error with allowed agents', async () => {
			let orchestratorCalls = 0
			let workerCalls = 0
			let workerReceivedErrorAboutTarget = false

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Do work' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					workerCalls++
					if (workerCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc2'), name: 'send_message', input: { to: 'nonexistent_agent', message: 'Should fail' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					// Second call: verify the tool result contains the error about invalid target
					const toolMessages = request.messages.filter(m => m.role === 'tool')
					if (toolMessages.some(m => typeof m.content === 'string' && m.content.includes('Cannot send message'))) {
						workerReceivedErrorAboutTarget = true
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			// No mailbox_message for invalid target
			const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			const invalidMessages = events.filter(e => e.message.content === 'Should fail')
			expect(invalidMessages).toHaveLength(0)

			// Worker was called exactly twice (tool call + error result)
			expect(workerCalls).toBe(2)

			// Worker received error message about invalid target with allowed agents
			expect(workerReceivedErrorAboutTarget).toBe(true)

			await harness.shutdown()
		})

		it('mailbox_message event emitted with correct from/to/content', async () => {
			let orchestratorCalls = 0
			let workerCalls = 0

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Task content' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					workerCalls++
					if (workerCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc2'), name: 'send_message', input: { to: 'parent', message: 'Result payload' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			const workerMessage = events.find(e => e.message.content === 'Result payload')
			expect(workerMessage).toBeDefined()
			expect(workerMessage!.toAgentId).toBe(session.getEntryAgentId()!)
			expect(workerMessage!.message.from).toBe(AgentId('worker_1'))
			expect(workerMessage!.message.consumed).toBe(false)
			expect(workerMessage!.message.timestamp).toBeGreaterThan(0)
			expect(workerMessage!.message.id).toBeDefined()

			await harness.shutdown()
		})

		it('idle agent re-scheduled when message sent via direct mailbox.send', async () => {
			let orchestratorCalls = 0
			let workerCalls = 0
			let workerSawFollowUp = false

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Initial work' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					workerCalls++
					const lastMsg = request.messages[request.messages.length - 1]
					if (typeof lastMsg?.content === 'string' && lastMsg.content.includes('Follow-up task')) {
						workerSawFollowUp = true
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			// Worker processed initial message and became idle
			expect(workerCalls).toBe(1)

			// Send a follow-up message directly — should re-schedule the idle worker
			const result = await session.callPluginMethod('mailbox.send', {
				fromAgentId: String(session.getEntryAgentId()!),
				toAgentId: 'worker_1',
				content: 'Follow-up task',
			})
			expect(result.ok).toBe(true)
			await session.waitForIdle()

			// Worker was re-scheduled and processed the new message
			expect(workerCalls).toBe(2)
			expect(workerSawFollowUp).toBe(true)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// dequeue
	// =========================================================================

	describe('dequeue', () => {
		it('unconsumed messages delivered to agent as LLM user message before inference', async () => {
			let orchestratorCalls = 0

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Process this data' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			// Find the worker's LLM request
			const calls = harness.llmProvider.getCallHistory()
			const workerCall = calls.find(c => c.systemPrompt.includes('Worker'))
			expect(workerCall).toBeDefined()

			// The mailbox message should be in the request as a user message
			const userMessages = workerCall!.messages.filter(m => m.role === 'user')
			expect(userMessages.length).toBeGreaterThanOrEqual(1)

			// The message content should contain the task (formatted as XML by formatMailboxForLLM)
			const lastUserMsg = userMessages[userMessages.length - 1]
			const content = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : ''
			expect(content).toContain('Process this data')
			expect(content).toContain('<message')

			await harness.shutdown()
		})

		it('messages marked as consumed after delivery (mailbox_consumed event)', async () => {
			let orchestratorCalls = 0

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Task for worker' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			// mailbox_consumed event emitted
			const consumedEvents = await session.getEventsByType(mailboxEvents, 'mailbox_consumed')
			const workerConsumed = consumedEvents.filter(e => e.agentId === AgentId('worker_1'))
			expect(workerConsumed).toHaveLength(1)

			// All worker messages should be consumed in state
			const mailboxState = selectMailboxState(session.state)
			const unconsumed = getAgentUnconsumedMailbox(mailboxState, AgentId('worker_1'))
			expect(unconsumed).toHaveLength(0)

			await harness.shutdown()
		})

		it('message ordering preserved — multiple messages delivered in sequence', async () => {
			let orchestratorCalls = 0

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'First message' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						if (orchestratorCalls === 2) {
							return {
								content: null,
								toolCalls: [
									{ id: ToolCallId('tc2'), name: 'send_message', input: { to: 'worker_1', message: 'Second message' } },
									{ id: ToolCallId('tc3'), name: 'send_message', input: { to: 'worker_1', message: 'Third message' } },
								],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			// Consumed payloads leave state; the event log remains the durable history.
			const allMessages = (await session.getEventsByType(mailboxEvents, 'mailbox_message'))
				.filter((event) => event.toAgentId === AgentId('worker_1'))
				.map((event) => event.message)
			expect(allMessages).toHaveLength(3)

			const contents = allMessages.map(m => m.content)
			expect(contents[0]).toBe('First message')
			expect(contents[1]).toBe('Second message')
			expect(contents[2]).toBe('Third message')

			await harness.shutdown()
		})

		it('messages from different senders all delivered', async () => {
			let orchestratorCalls = 0
			let worker1Calls = 0
			let subworkerCalls = 0

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: ['subworker'] },
					{ name: 'subworker', system: 'Subworker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Go' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					if (request.systemPrompt.includes('Worker agent')) {
						worker1Calls++
						if (worker1Calls === 1) {
							// Worker spawns subworker
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc2'), name: 'start_subworker', input: { message: 'Subtask' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					// Subworker
					subworkerCalls++
					if (subworkerCalls === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc3'), name: 'send_message', input: { to: 'parent', message: 'From subworker' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Subworker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start', { timeoutMs: 10000 })

			// Worker received both messages, while consumed payloads were pruned from state.
			const workerMailbox = (await session.getEventsByType(mailboxEvents, 'mailbox_message'))
				.filter((event) => event.toAgentId === AgentId('worker_1'))
				.map((event) => event.message)

			const fromOrchestrator = workerMailbox.filter(m => m.from === session.getEntryAgentId()!)
			const fromSubworker = workerMailbox.filter(m => m.from === AgentId('subworker_1'))

			expect(fromOrchestrator).toHaveLength(1)
			expect(fromSubworker).toHaveLength(1)
			expect(getAgentMailbox(selectMailboxState(session.state), AgentId('worker_1'))).toHaveLength(0)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// onComplete hook
	// =========================================================================

	describe('onComplete hook', () => {
		it('agent with sendCompletionMessage: true → parent receives "Task completed." on agent completion', async () => {
			let orchestratorCalls = 0

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{
						name: 'worker',
						system: 'Worker agent.',
						tools: [],
						agents: [],
						plugins: [{ pluginName: 'mailbox', config: { sendCompletionMessage: true } }],
					},
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Do work' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					// Worker responds with content only → completes → onComplete fires
					return { content: 'Work finished', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			// Check that "Task completed." was sent to parent
			const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			const completionMessages = events.filter(e => e.message.content === 'Task completed.')
			expect(completionMessages).toHaveLength(1)
			expect(completionMessages[0].toAgentId).toBe(session.getEntryAgentId()!)
			expect(completionMessages[0].message.from).toBe(AgentId('worker_1'))

			await harness.shutdown()
		})

		it('agent with sendCompletionMessage: false → no completion message', async () => {
			let orchestratorCalls = 0

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{
						name: 'worker',
						system: 'Worker agent.',
						tools: [],
						agents: [],
						// No sendCompletionMessage config
					},
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Do work' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}

					return { content: 'Work finished', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			const completionMessages = events.filter(e => e.message.content === 'Task completed.')
			expect(completionMessages).toHaveLength(0)

			await harness.shutdown()
		})

		it('empty-stop LLM response → agent retries; persistent empty → coalesces to WAITING, no error', async () => {
			let workerCalls = 0
			let orchestratorCalls = 0

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Do work' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}
					workerCalls++
					// Always empty-stop → triggers retry until exhausted, then coalesces to WAITING
					return { content: null, toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			// Initial + 2 retries = 3 worker LLM calls
			expect(workerCalls).toBe(3)

			// No error message to parent — exhaustion coalesces to WAITING, not failure
			const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			const errMsg = events.find(e =>
				e.message.from === AgentId('worker_1')
				&& typeof e.message.content === 'string'
				&& e.message.content.startsWith('Agent encountered an error:'),
			)
			expect(errMsg).toBeUndefined()

			await harness.shutdown()
		})

		it('empty-stop LLM response → recovers on retry, no error sent', async () => {
			let workerCalls = 0
			let orchestratorCalls = 0

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Do work' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}
					workerCalls++
					if (workerCalls === 1) {
						return { content: null, toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}
					return { content: 'Recovered', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			expect(workerCalls).toBe(2)

			const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			const errMsg = events.find(e =>
				typeof e.message.content === 'string'
				&& e.message.content.startsWith('Agent encountered an error:'),
			)
			expect(errMsg).toBeUndefined()

			await harness.shutdown()
		})

		it('agent without parent → no completion message even with flag true', async () => {
			const harness = new TestHarness({
				presets: [createTestPreset({
					orchestratorPlugins: [
						{ pluginName: 'mailbox', config: { sendCompletionMessage: true } },
					],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Test')

			// Orchestrator has no parent → no completion message
			const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			const completionMessages = events.filter(e => e.message.content === 'Task completed.')
			expect(completionMessages).toHaveLength(0)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// send method (direct)
	// =========================================================================

	describe('send method (direct)', () => {
		it('reserves unique concurrent IDs before an interleaved consumption', async () => {
			const eventStore = new InterleavedMailboxEventStore()
			const seenContent: string[] = []
			const harness = new TestHarness({
				presets: [createTestPreset()],
				eventStore,
				mockHandler: (request) => {
					seenContent.push(request.messages.map((message) =>
						typeof message.content === 'string' ? message.content : '',
					).join('\n'))
					return {
						content: 'Done',
						toolCalls: [],
						finishReason: 'stop',
						metrics: MockLLMProvider.defaultMetrics(),
					}
				},
			})

			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			const firstSend = session.callPluginMethod('mailbox.send', {
				toAgentId: String(entryAgentId),
				content: 'first concurrent payload',
				debug: true,
			})
			const secondSend = session.callPluginMethod('mailbox.send', {
				toAgentId: String(entryAgentId),
				content: 'second concurrent payload',
				debug: true,
			})

			await eventStore.secondMailboxAppendStarted.promise
			await waitUntil(() => eventStore.getEventsByType(
				session.sessionId,
				'mailbox_consumed',
			).length === 1)
			const firstConsumption = await session.getEventsByType(mailboxEvents, 'mailbox_consumed')
			expect(firstConsumption[0].messageIds).toEqual([MessageId('m1')])

			eventStore.releaseSecondMailboxAppend.resolve()
			const results = await Promise.all([firstSend, secondSend])
			expect(results.every((result) => result.ok)).toBe(true)
			await session.waitForIdle()

			const messages = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			expect(messages.map((event) => event.message.id).sort()).toEqual([
				MessageId('m1'),
				MessageId('m2'),
			])
			expect(seenContent).toHaveLength(2)
			expect(seenContent[0]).toContain('first concurrent payload')
			expect(seenContent[0]).not.toContain('second concurrent payload')
			expect(seenContent[1]).toContain('second concurrent payload')
			const consumptions = await session.getEventsByType(mailboxEvents, 'mailbox_consumed')
			expect(consumptions.map((event) => event.messageIds)).toEqual([
				[MessageId('m1')],
				[MessageId('m2')],
			])

			await harness.shutdown()
		})

		it('returns a domain error when reservation is attempted after close', async () => {
			const harness = new TestHarness({ presets: [createTestPreset()] })
			const session = await harness.createSession('test')
			const entryAgentId = session.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			await session.close()

			const result = await session.callPluginMethod('mailbox.send', {
				toAgentId: String(entryAgentId),
				content: 'late payload',
				debug: true,
			})
			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.error.type).toBe('session_closed')

			await harness.shutdown()
		})

		it('legacy replay preserves the sequence and prunes only addressed payloads', async () => {
			const firstHarness = new TestHarness({
				presets: [createTestPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})
			const firstSession = await firstHarness.createSession('test')
			const sessionId = firstSession.sessionId
			const entryAgentId = firstSession.getEntryAgentId()
			if (!entryAgentId) throw new Error('Expected entry agent')
			const otherAgentId = AgentId('other_1')
			const eventStore = firstHarness.eventStore
			await firstHarness.shutdown()

			await eventStore.appendBatch(sessionId, [
				withSessionId(sessionId, mailboxEvents.create('mailbox_message', {
					toAgentId: entryAgentId,
					message: {
						id: MessageId('m40'),
						from: 'user',
						content: 'consumed legacy payload',
						timestamp: 40,
						consumed: false,
						attachments: [{
							uploadId: UploadId('legacy-upload'),
							filename: 'large.txt',
							mimeType: 'text/plain',
							size: 1000,
							path: '/legacy/large.txt',
							extractedContent: 'large extracted content',
						}],
					},
				})),
				withSessionId(sessionId, mailboxEvents.create('mailbox_message', {
					toAgentId: otherAgentId,
					message: {
						id: MessageId('m41'),
						from: 'user',
						content: 'other agent payload',
						timestamp: 41,
						consumed: false,
					},
				})),
				withSessionId(sessionId, mailboxEvents.create('mailbox_consumed', {
					agentId: entryAgentId,
					messageIds: [MessageId('m40')],
				})),
			])

			const secondHarness = new TestHarness({
				presets: [createTestPreset()],
				eventStore,
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Done', toolCalls: [] }),
			})
			const replayedSession = await secondHarness.openSession(sessionId)
			const mailboxState = selectMailboxState(replayedSession.state)
			expect(getAgentMailbox(mailboxState, entryAgentId)).toHaveLength(0)
			expect(getAgentMailbox(mailboxState, otherAgentId).map((message) => message.id)).toEqual([
				MessageId('m41'),
			])

			await replayedSession.callPluginMethod('mailbox.send', {
				toAgentId: String(entryAgentId),
				content: 'new payload',
				debug: true,
			})
			await replayedSession.waitForIdle()

			const messages = await replayedSession.getEventsByType(mailboxEvents, 'mailbox_message')
			const newMessage = messages.find((event) => event.message.content === 'new payload')
			expect(newMessage?.message.id).toBe(MessageId('m42'))
			expect(newMessage?.sequence).toBe(42)
			expect(getAgentMailbox(selectMailboxState(replayedSession.state), entryAgentId)).toHaveLength(0)

			await secondHarness.shutdown()
		})

		it('mailbox.send between valid agents → message delivered', async () => {
			let orchestratorCalls = 0

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							return {
								content: null,
								toolCalls: [{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Init' } }],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			const orchestratorId = session.getEntryAgentId()!

			// Send via direct method
			const result = await session.callPluginMethod('mailbox.send', {
				fromAgentId: String(orchestratorId),
				toAgentId: 'worker_1',
				content: 'Direct hello',
			})

			expect(result.ok).toBe(true)

			// Event emitted
			const events = await session.getEventsByType(mailboxEvents, 'mailbox_message')
			const directMsg = events.find(e => e.message.content === 'Direct hello')
			expect(directMsg).toBeDefined()
			expect(directMsg!.toAgentId).toBe(AgentId('worker_1'))
			expect(directMsg!.message.from).toBe(orchestratorId)

			await harness.shutdown()
		})

		it('mailbox.send between non-related agents → error', async () => {
			let orchestratorCalls = 0

			const harness = new TestHarness({
				presets: [createMultiAgentPreset([
					{ name: 'worker', system: 'Worker agent.', tools: [], agents: [] },
				], { orchestratorSystem: 'Orchestrator agent.' })],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							// Spawn two workers
							return {
								content: null,
								toolCalls: [
									{ id: ToolCallId('tc1'), name: 'start_worker', input: { message: 'Task 1' } },
									{ id: ToolCallId('tc2'), name: 'start_worker', input: { message: 'Task 2' } },
								],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			// Try to send between siblings (worker_1 → worker_2)
			const result = await session.callPluginMethod('mailbox.send', {
				fromAgentId: 'worker_1',
				toAgentId: 'worker_2',
				content: 'Should fail',
			})

			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.error.message).toContain('Cannot send message')
			}

			await harness.shutdown()
		})
	})
})
