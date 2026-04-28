import { describe, expect, it } from 'bun:test'
import { MockLLMProvider } from '~/core/llm/mock.js'
import { selectPluginState } from '~/core/sessions/reducer.js'
import { ToolCallId } from '~/core/tools/schema.js'
import { createTestPreset, TestHarness } from '~/testing/index.js'
import { todoEvents, todoPlugin } from './index.js'
import type { TodoEntry, TodoId } from './schema.js'

function createTodoPreset(overrides?: Parameters<typeof createTestPreset>[0]) {
	return createTestPreset({
		...overrides,
		plugins: [todoPlugin.configure({}), ...(overrides?.plugins ?? [])],
	})
}

function createTodoHarness(options: Omit<ConstructorParameters<typeof TestHarness>[0], 'systemPlugins'>) {
	return new TestHarness({ ...options, systemPlugins: [todoPlugin] })
}

/**
 * Extract todoId from LLM request messages (finds the tool result containing todoId).
 */
function extractTodoIdFromMessages(messages: Array<{ role: string; content: unknown }>): string | null {
	for (const msg of messages) {
		if (msg.role === 'tool' && typeof msg.content === 'string') {
			const match = msg.content.match(/"todoId":"([^"]+)"/)
			if (match) return match[1]
		}
	}
	return null
}

describe('todo plugin', () => {
	// =========================================================================
	// todo_create tool
	// =========================================================================

	describe('todo_create tool', () => {
		it('agent calls todo_create → todo_created event → todo in state', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'todo_create',
							input: { title: 'Fix bug', description: 'Fix the login bug' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Create a todo')

			const events = await session.getEventsByType('todo_created')
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'todo_created',
				title: 'Fix bug',
				description: 'Fix the login bug',
			})

			const todos = selectPluginState<Map<TodoId, TodoEntry>>(session.state, 'todos')
			expect(todos).toBeDefined()
			expect(todos!.size).toBe(1)
			const todo = Array.from(todos!.values())[0]
			expect(todo.title).toBe('Fix bug')
			expect(todo.status).toBe('pending')

			await harness.shutdown()
		})

		it('created todo has status pending, correct title, description, metadata', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'todo_create',
							input: { title: 'Deploy', description: 'Deploy to prod', metadata: { priority: 'high' } },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Create')

			const todo = Array.from(selectPluginState<Map<TodoId, TodoEntry>>(session.state, 'todos')!.values())[0]
			expect(todo.status).toBe('pending')
			expect(todo.title).toBe('Deploy')
			expect(todo.description).toBe('Deploy to prod')
			expect(todo.metadata).toMatchObject({ priority: 'high' })

			await harness.shutdown()
		})
	})

	// =========================================================================
	// todo_update tool
	// =========================================================================

	describe('todo_update tool', () => {
		it('todo_update changes title → state updated', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset()],
				mockHandler: (request) => {
					const callCount = harness.llmProvider.getCallCount()
					if (callCount === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc1'), name: 'todo_create', input: { title: 'Old title' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					if (callCount === 2) {
						const todoId = extractTodoIdFromMessages(request.messages)
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc2'), name: 'todo_update', input: { todoId, title: 'New title' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Update todo')

			const todo = Array.from(selectPluginState<Map<TodoId, TodoEntry>>(session.state, 'todos')!.values())[0]
			expect(todo.title).toBe('New title')

			await harness.shutdown()
		})

		it('todo_update changes status to completed → completedAt set', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset()],
				mockHandler: (request) => {
					const callCount = harness.llmProvider.getCallCount()
					if (callCount === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc1'), name: 'todo_create', input: { title: 'Complete me' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					if (callCount === 2) {
						const todoId = extractTodoIdFromMessages(request.messages)
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc2'), name: 'todo_update', input: { todoId, status: 'completed' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Complete todo')

			const todo = Array.from(selectPluginState<Map<TodoId, TodoEntry>>(session.state, 'todos')!.values())[0]
			expect(todo.status).toBe('completed')
			expect(todo.completedAt).toBeDefined()

			await harness.shutdown()
		})

		it('todo_update changes status to cancelled → cancelledAt set', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset()],
				mockHandler: (request) => {
					const callCount = harness.llmProvider.getCallCount()
					if (callCount === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc1'), name: 'todo_create', input: { title: 'Cancel me' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					if (callCount === 2) {
						const todoId = extractTodoIdFromMessages(request.messages)
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc2'), name: 'todo_update', input: { todoId, status: 'cancelled' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Cancel todo')

			const todo = Array.from(selectPluginState<Map<TodoId, TodoEntry>>(session.state, 'todos')!.values())[0]
			expect(todo.status).toBe('cancelled')
			expect(todo.cancelledAt).toBeDefined()

			await harness.shutdown()
		})

		it('todo_update merges metadata', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset()],
				mockHandler: (request) => {
					const callCount = harness.llmProvider.getCallCount()
					if (callCount === 1) {
						return {
							content: null,
							toolCalls: [{
								id: ToolCallId('tc1'),
								name: 'todo_create',
								input: { title: 'Meta todo', metadata: { priority: 'high', category: 'bug' } },
							}],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					if (callCount === 2) {
						const todoId = extractTodoIdFromMessages(request.messages)
						return {
							content: null,
							toolCalls: [{
								id: ToolCallId('tc2'),
								name: 'todo_update',
								input: { todoId, metadata: { category: 'feature', owner: 'alice' } },
							}],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Update metadata')

			const todo = Array.from(selectPluginState<Map<TodoId, TodoEntry>>(session.state, 'todos')!.values())[0]
			// Shallow merge: priority kept, category overwritten, owner added
			expect(todo.metadata).toMatchObject({ priority: 'high', category: 'feature', owner: 'alice' })

			await harness.shutdown()
		})

		it('todo_update non-existent todo → error result', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'todo_update',
							input: { todoId: 'nonexistent', title: 'nope' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Update missing')

			// No todo_updated event should have been emitted
			const updateEvents = await session.getEventsByType('todo_updated')
			expect(updateEvents).toHaveLength(0)

			// Error was propagated back to the LLM (called twice: initial + after error)
			expect(harness.llmProvider.getCallCount()).toBe(2)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// todo_delete tool
	// =========================================================================

	describe('todo_delete tool', () => {
		it('todo_delete → todo_deleted event → todo removed from state', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset()],
				mockHandler: (request) => {
					const callCount = harness.llmProvider.getCallCount()
					if (callCount === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc1'), name: 'todo_create', input: { title: 'Delete me' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					if (callCount === 2) {
						const todoId = extractTodoIdFromMessages(request.messages)
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc2'), name: 'todo_delete', input: { todoId } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Delete todo')

			const events = await session.getEventsByType('todo_deleted')
			expect(events).toHaveLength(1)

			expect(selectPluginState<Map<TodoId, TodoEntry>>(session.state, 'todos')!.size).toBe(0)

			await harness.shutdown()
		})

		it('todo_delete non-existent todo → error result', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [{
							id: ToolCallId('tc1'),
							name: 'todo_delete',
							input: { todoId: 'nonexistent' },
						}],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Delete missing')

			// No todo_deleted event should have been emitted
			const deleteEvents = await session.getEventsByType('todo_deleted')
			expect(deleteEvents).toHaveLength(0)

			// Error was propagated back to the LLM (called twice: initial + after error)
			expect(harness.llmProvider.getCallCount()).toBe(2)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// todo_list tool
	// =========================================================================

	describe('todo_list tool', () => {
		it('todo_list with status: pending → only pending todos', async () => {
			let listResult: string | null = null
			const harness = createTodoHarness({
				presets: [createTodoPreset()],
				mockHandler: (request) => {
					const callCount = harness.llmProvider.getCallCount()
					if (callCount === 1) {
						return {
							content: null,
							toolCalls: [
								{ id: ToolCallId('tc1'), name: 'todo_create', input: { title: 'Pending task' } },
								{ id: ToolCallId('tc2'), name: 'todo_create', input: { title: 'Complete task' } },
							],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					if (callCount === 2) {
						// Complete the second todo
						const todoIds: string[] = []
						for (const msg of request.messages) {
							if (msg.role === 'tool' && typeof msg.content === 'string') {
								const matches = msg.content.matchAll(/"todoId":"([^"]+)"/g)
								for (const m of matches) todoIds.push(m[1])
							}
						}
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc3'), name: 'todo_update', input: { todoId: todoIds[1], status: 'completed' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					if (callCount === 3) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc4'), name: 'todo_list', input: { status: 'pending' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					// Capture the tool result from todo_list
					for (const msg of request.messages) {
						if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.includes('Pending task')) {
							listResult = msg.content
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Filter todos')

			expect(listResult).not.toBeNull()
			const parsed = JSON.parse(listResult!)
			expect(parsed).toHaveLength(1)
			expect(parsed[0].title).toBe('Pending task')

			await harness.shutdown()
		})

		it('todo_list with status: completed → only completed todos', async () => {
			let listResult: string | null = null
			const harness = createTodoHarness({
				presets: [createTodoPreset()],
				mockHandler: (request) => {
					const callCount = harness.llmProvider.getCallCount()
					if (callCount === 1) {
						return {
							content: null,
							toolCalls: [
								{ id: ToolCallId('tc1'), name: 'todo_create', input: { title: 'Still pending' } },
								{ id: ToolCallId('tc2'), name: 'todo_create', input: { title: 'Will complete' } },
							],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					if (callCount === 2) {
						const todoIds: string[] = []
						for (const msg of request.messages) {
							if (msg.role === 'tool' && typeof msg.content === 'string') {
								const matches = msg.content.matchAll(/"todoId":"([^"]+)"/g)
								for (const m of matches) todoIds.push(m[1])
							}
						}
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc3'), name: 'todo_update', input: { todoId: todoIds[1], status: 'completed' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					if (callCount === 3) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc4'), name: 'todo_list', input: { status: 'completed' } }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					for (const msg of request.messages) {
						if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.includes('Will complete')) {
							listResult = msg.content
						}
					}
					return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Filter completed')

			expect(listResult).not.toBeNull()
			const parsed = JSON.parse(listResult!)
			expect(parsed).toHaveLength(1)
			expect(parsed[0].title).toBe('Will complete')

			await harness.shutdown()
		})

		it('agent A todos not visible in agent B todo_list', async () => {
			let workerListResult: string | null = null
			let orchestratorCalls = 0

			const harness = createTodoHarness({
				presets: [createTodoPreset({
					orchestratorSystem: 'Orchestrator agent.',
					agents: [{
						name: 'worker',
						system: 'Worker agent.',
						tools: [],
						agents: [],
						plugins: [{ pluginName: 'todos', config: {} }],
					}],
				})],
				mockHandler: (request) => {
					if (request.systemPrompt.includes('Orchestrator')) {
						orchestratorCalls++
						if (orchestratorCalls === 1) {
							// Orchestrator creates a todo, then spawns worker
							return {
								content: null,
								toolCalls: [
									{ id: ToolCallId('tc1'), name: 'todo_create', input: { title: 'Orchestrator todo' } },
									{ id: ToolCallId('tc2'), name: 'start_worker', input: { message: 'List your todos' } },
								],
								finishReason: 'stop',
								metrics: MockLLMProvider.defaultMetrics(),
							}
						}
						return { content: 'Done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
					}
					// Worker: list todos (should see none from orchestrator)
					const workerCallCount = harness.llmProvider.getCallHistory()
						.filter((r) => r.systemPrompt.includes('Worker')).length
					if (workerCallCount === 1) {
						return {
							content: null,
							toolCalls: [{ id: ToolCallId('tc3'), name: 'todo_list', input: {} }],
							finishReason: 'stop',
							metrics: MockLLMProvider.defaultMetrics(),
						}
					}
					// Capture the todo_list result
					for (const msg of request.messages) {
						if (msg.role === 'tool' && typeof msg.content === 'string') {
							workerListResult = msg.content
						}
					}
					return { content: 'Worker done', toolCalls: [], finishReason: 'stop', metrics: MockLLMProvider.defaultMetrics() }
				},
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Start')

			// Orchestrator should have 1 todo
			expect(selectPluginState<Map<TodoId, TodoEntry>>(session.state, 'todos')!.size).toBe(1)

			// Worker's list should be empty (orchestrator's todos not visible)
			expect(workerListResult).not.toBeNull()
			const parsed = JSON.parse(workerListResult!)
			expect(parsed).toHaveLength(0)

			await harness.shutdown()
		})

		it('todo_list → returns all agent todos', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset()],
				llmProvider: MockLLMProvider.withSequence([
					{
						toolCalls: [
							{ id: ToolCallId('tc1'), name: 'todo_create', input: { title: 'Task A' } },
							{ id: ToolCallId('tc2'), name: 'todo_create', input: { title: 'Task B' } },
						],
					},
					{
						toolCalls: [
							{ id: ToolCallId('tc3'), name: 'todo_list', input: {} },
						],
					},
					{ content: 'Done', toolCalls: [] },
				]),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('List todos')

			// Verify both todos exist in state
			expect(selectPluginState<Map<TodoId, TodoEntry>>(session.state, 'todos')!.size).toBe(2)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// onStart hook (initial todos)
	// =========================================================================

	describe('onStart hook (initial todos)', () => {
		it('agent config with initial todos → todos created on agent start', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset({
					orchestratorPlugins: [
						{
							pluginName: 'todos',
							config: {
								initial: [
									{ title: 'Setup environment' },
									{ title: 'Read docs' },
								],
							},
						},
					],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const events = await session.getEventsByType(todoEvents, 'todo_created')
			expect(events).toHaveLength(2)

			const titles = events.map((e) => e.title)
			expect(titles).toContain('Setup environment')
			expect(titles).toContain('Read docs')

			expect(selectPluginState<Map<TodoId, TodoEntry>>(session.state, 'todos')!.size).toBe(2)

			await harness.shutdown()
		})

		it('no initial config → no todos created', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset()],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const events = await session.getEventsByType('todo_created')
			expect(events).toHaveLength(0)

			await harness.shutdown()
		})
	})

	// =========================================================================
	// disabled
	// =========================================================================

	describe('disabled', () => {
		it('preset enabled: false → no todo tools', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset({
					plugins: [
						todoPlugin.configure({ enabled: false }),
					],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const lastRequest = harness.llmProvider.getLastRequest()
			const toolNames = lastRequest?.tools?.map((t) => t.name) ?? []
			expect(toolNames).not.toContain('todo_create')
			expect(toolNames).not.toContain('todo_update')
			expect(toolNames).not.toContain('todo_delete')
			expect(toolNames).not.toContain('todo_list')

			await harness.shutdown()
		})

		it('agent enabled: false → no todo tools for that agent', async () => {
			const harness = createTodoHarness({
				presets: [createTodoPreset({
					orchestratorPlugins: [
						todoPlugin.configureAgent({ enabled: false }),
					],
				})],
				llmProvider: MockLLMProvider.withFixedResponse({ content: 'Ok', toolCalls: [] }),
			})

			const session = await harness.createSession('test')
			await session.sendAndWaitForIdle('Hi')

			const lastRequest = harness.llmProvider.getLastRequest()
			const toolNames = lastRequest?.tools?.map((t) => t.name) ?? []
			expect(toolNames).not.toContain('todo_create')
			expect(toolNames).not.toContain('todo_update')
			expect(toolNames).not.toContain('todo_delete')
			expect(toolNames).not.toContain('todo_list')

			await harness.shutdown()
		})
	})
})
