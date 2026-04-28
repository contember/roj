/**
 * Todo Status Prompt Builder
 *
 * Builds a system message section describing the current state
 * of todos for injection into agent context.
 */

import type { TodoEntry } from './schema.js'

/**
 * Build a todo status message for agent context.
 * Returns null if there are no todos to show.
 */
export function buildTodoStatusMessage(todos: TodoEntry[]): string | null {
	if (todos.length === 0) return null

	const lines: string[] = [
		'## Your Current Todos',
		'',
	]

	// Group by status
	const pending = todos.filter((t) => t.status === 'pending')
	const inProgress = todos.filter((t) => t.status === 'in_progress')
	const completed = todos.filter((t) => t.status === 'completed')
	const cancelled = todos.filter((t) => t.status === 'cancelled')

	if (inProgress.length > 0) {
		lines.push('**In Progress:**')
		for (const todo of inProgress) {
			lines.push(`- [${todo.id}] ${todo.title}`)
		}
		lines.push('')
	}

	if (pending.length > 0) {
		lines.push('**Pending:**')
		for (const todo of pending) {
			lines.push(`- [${todo.id}] ${todo.title}`)
		}
		lines.push('')
	}

	if (completed.length > 0) {
		lines.push('**Completed:**')
		for (const todo of completed) {
			lines.push(`- [${todo.id}] ${todo.title}`)
		}
		lines.push('')
	}

	if (cancelled.length > 0) {
		lines.push('**Cancelled:**')
		for (const todo of cancelled) {
			lines.push(`- [${todo.id}] ${todo.title}`)
		}
		lines.push('')
	}

	lines.push('Use todo tools (todo_update, todo_delete, todo_list) to manage your todos.')

	return lines.join('\n')
}
