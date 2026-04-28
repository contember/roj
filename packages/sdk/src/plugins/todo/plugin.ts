import z from 'zod/v4'
import { agentIdSchema } from '~/core/agents/schema.js'
import { ValidationErrors } from '~/core/errors.js'
import { createEventsFactory } from '~/core/events/types.js'
import { definePlugin } from '~/core/plugins/plugin-builder.js'
import { createTool } from '~/core/tools/definition.js'
import { Err, Ok } from '~/lib/utils/result.js'
import { buildTodoStatusMessage } from './prompts.js'
import type { TodoEntry, TodoId, TodoStatus } from './schema.js'
import { generateTodoId, TodoId as createTodoId, todoIdSchema } from './schema.js'

export const todoEvents = createEventsFactory({
	events: {
		todo_created: z.object({
			agentId: agentIdSchema,
			todoId: todoIdSchema,
			title: z.string(),
			description: z.string().optional(),
			metadata: z.record(z.string(), z.unknown()).optional(),
		}),
		todo_updated: z.object({
			todoId: todoIdSchema,
			agentId: agentIdSchema,
			title: z.string().optional(),
			description: z.string().optional(),
			status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
			metadata: z.record(z.string(), z.unknown()).optional(),
		}),
		todo_deleted: z.object({
			todoId: todoIdSchema,
			agentId: agentIdSchema,
		}),
	},
})

export type TodoCreatedEvent = (typeof todoEvents)['Events']['todo_created']
export type TodoUpdatedEvent = (typeof todoEvents)['Events']['todo_updated']
export type TodoDeletedEvent = (typeof todoEvents)['Events']['todo_deleted']

/**
 * Session-wide todo configuration.
 */
export interface TodoPresetConfig {
	/** Whether todos are enabled by default (default: true) */
	enabled?: boolean
}

/**
 * Agent-specific todo configuration.
 */
export interface TodoAgentConfig {
	/** Whether todos are enabled for this agent (default: true) */
	enabled?: boolean
	/** Initial todos to create when agent spawns */
	initial?: Array<{
		title: string
		description?: string
		metadata?: Record<string, unknown>
	}>
}

const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const

export const todoPlugin = definePlugin('todos')
	.pluginConfig<TodoPresetConfig>()
	.agentConfig<TodoAgentConfig>()
	.events([todoEvents])
	.state({
		key: 'todos',
		initial: (): Map<TodoId, TodoEntry> => new Map(),
		reduce: (todos, event) => {
			switch (event.type) {
				case 'todo_created': {
					const todoEntry: TodoEntry = {
						id: event.todoId,
						agentId: event.agentId,
						title: event.title,
						description: event.description,
						status: 'pending',
						metadata: event.metadata,
						createdAt: event.timestamp,
						updatedAt: event.timestamp,
					}
					const newTodos = new Map(todos)
					newTodos.set(event.todoId, todoEntry)
					return newTodos
				}

				case 'todo_updated': {
					const todo = todos.get(event.todoId)
					if (!todo) return todos

					const updated: TodoEntry = {
						...todo,
						updatedAt: event.timestamp,
					}

					if (event.title !== undefined) {
						updated.title = event.title
					}
					if (event.description !== undefined) {
						updated.description = event.description
					}
					if (event.status !== undefined) {
						updated.status = event.status
						if (event.status === 'completed') {
							updated.completedAt = event.timestamp
						}
						if (event.status === 'cancelled') {
							updated.cancelledAt = event.timestamp
						}
					}
					if (event.metadata !== undefined) {
						updated.metadata = { ...updated.metadata, ...event.metadata }
					}

					const newTodos = new Map(todos)
					newTodos.set(event.todoId, updated)
					return newTodos
				}

				case 'todo_deleted': {
					const newTodos = new Map(todos)
					newTodos.delete(event.todoId)
					return newTodos
				}

				default:
					return todos
			}
		},
	})
	.method('create', {
		input: z.object({
			agentId: agentIdSchema,
			title: z.string(),
			description: z.string().optional(),
			metadata: z.record(z.string(), z.unknown()).optional(),
		}),
		output: z.object({
			todoId: z.string(),
		}),
		handler: async (ctx, input) => {
			const todoId = generateTodoId()
			await ctx.emitEvent(todoEvents.create('todo_created', {
				agentId: input.agentId,
				todoId,
				title: input.title,
				description: input.description,
				metadata: input.metadata,
			}))

			return Ok({ todoId })
		},
	})
	.method('update', {
		input: z.object({
			agentId: agentIdSchema,
			todoId: todoIdSchema,
			title: z.string().optional(),
			description: z.string().optional(),
			status: z.enum(TODO_STATUSES).optional(),
			metadata: z.record(z.string(), z.unknown()).optional(),
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const todo = ctx.pluginState.get(input.todoId)
			if (!todo) {
				return Err(ValidationErrors.invalid(`Todo ${input.todoId} not found`))
			}

			await ctx.emitEvent(todoEvents.create('todo_updated', {
				agentId: input.agentId,
				todoId: input.todoId,
				title: input.title,
				description: input.description,
				status: input.status,
				metadata: input.metadata,
			}))

			return Ok({})
		},
	})
	.method('delete', {
		input: z.object({
			agentId: agentIdSchema,
			todoId: todoIdSchema,
		}),
		output: z.object({}),
		handler: async (ctx, input) => {
			const todo = ctx.pluginState.get(input.todoId)
			if (!todo) {
				return Err(ValidationErrors.invalid(`Todo ${input.todoId} not found`))
			}

			await ctx.emitEvent(todoEvents.create('todo_deleted', {
				agentId: input.agentId,
				todoId: input.todoId,
			}))

			return Ok({})
		},
	})
	.method('list', {
		input: z.object({
			agentId: agentIdSchema,
			status: z.enum(TODO_STATUSES).optional(),
		}),
		output: z.object({
			todos: z.array(
				z.object({
					todoId: todoIdSchema,
					title: z.string(),
					description: z.string().optional(),
					status: z.string(),
					agentId: agentIdSchema,
					createdAt: z.number(),
					updatedAt: z.number(),
					metadata: z.record(z.string(), z.unknown()).optional(),
				}),
			),
		}),
		handler: async (ctx, input) => {
			const agentTodos = Array.from(ctx.pluginState.values())
				.filter((todo) => todo.agentId === input.agentId)

			const filtered = agentTodos.filter((todo) => {
				if (input.status && todo.status !== input.status) return false
				return true
			})

			return Ok({
				todos: filtered.map((t) => ({
					todoId: t.id,
					title: t.title,
					description: t.description,
					status: t.status,
					agentId: t.agentId,
					createdAt: t.createdAt,
					updatedAt: t.updatedAt,
					metadata: t.metadata,
				})),
			})
		},
	})
	.tools((ctx) => {
		const enabled = ctx.pluginConfig.enabled !== false
		if (!enabled) return []

		const agentEnabled = ctx.pluginAgentConfig?.enabled !== false
		if (!agentEnabled) return []

		return [
			createTool({
				name: 'todo_create',
				description: 'Create a new todo item to track a task or objective.',
				input: z.object({
					title: z.string().describe('Short title for the todo (required)'),
					description: z.string().optional().describe('Detailed description (optional)'),
					metadata: z.record(z.string(), z.unknown()).optional().describe('Optional metadata (tags, priority, etc.)'),
				}),
				execute: async (input, context) => {
					const result = await ctx.self.create({
						agentId: context.agentId,
						title: input.title,
						description: input.description,
						metadata: input.metadata,
					})
					if (!result.ok) return Err({ message: result.error.message, recoverable: false })
					return Ok(JSON.stringify({ todoId: result.value.todoId, status: 'created' }))
				},
			}),

			createTool({
				name: 'todo_update',
				description: 'Update an existing todo (title, description, status, or metadata).',
				input: z.object({
					todoId: todoIdSchema,
					title: z.string().optional().describe('New title'),
					description: z.string().optional().describe('New description'),
					status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional()
						.describe('New status'),
					metadata: z.record(z.string(), z.unknown()).optional().describe('Metadata to merge'),
				}),
				execute: async (input, context) => {
					const result = await ctx.self.update({
						agentId: context.agentId,
						todoId: input.todoId,
						title: input.title,
						description: input.description,
						status: input.status,
						metadata: input.metadata,
					})
					if (!result.ok) return Err({ message: result.error.message, recoverable: false })
					return Ok(JSON.stringify({ todoId: input.todoId, status: 'updated' }))
				},
			}),

			createTool({
				name: 'todo_delete',
				description: 'Delete a todo item.',
				input: z.object({
					todoId: todoIdSchema,
				}),
				execute: async (input, context) => {
					const result = await ctx.self.delete({
						agentId: context.agentId,
						todoId: input.todoId,
					})
					if (!result.ok) return Err({ message: result.error.message, recoverable: false })
					return Ok(JSON.stringify({ todoId: input.todoId, status: 'deleted' }))
				},
			}),

			createTool({
				name: 'todo_list',
				description: 'List your todos. By default shows only your own todos, optionally filtered by status.',
				input: z.object({
					status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional()
						.describe('Filter by status (optional)'),
				}),
				execute: async (input, context) => {
					const result = await ctx.self.list({
						agentId: context.agentId,
						status: input.status,
					})
					if (!result.ok) return Err({ message: result.error.message, recoverable: false })
					return Ok(JSON.stringify(result.value.todos))
				},
			}),
		]
	})
	.status((ctx) => {
		const enabled = ctx.pluginConfig.enabled !== false
		if (!enabled) return null

		const agentEnabled = ctx.pluginAgentConfig?.enabled !== false
		if (!agentEnabled) return null

		const agentTodos = Array.from(ctx.pluginState.values())
			.filter((todo) => todo.agentId === ctx.agentId)

		return buildTodoStatusMessage(agentTodos)
	})
	.hook('onStart', async (ctx) => {
		const initialTodos = ctx.pluginAgentConfig?.initial
		if (!initialTodos || initialTodos.length === 0) {
			return null
		}

		for (const todo of initialTodos) {
			await ctx.emitEvent(todoEvents.create('todo_created', {
				agentId: ctx.agentId,
				todoId: generateTodoId(),
				title: todo.title,
				description: todo.description,
				metadata: todo.metadata,
			}))
		}

		return null
	})
	.build()
