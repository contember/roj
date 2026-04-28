// Plugin
export { todoPlugin } from './plugin.js'
export type { TodoAgentConfig, TodoPresetConfig } from './plugin.js'

// Schema
export { generateTodoId, TodoId, todoIdSchema } from './schema.js'
export type { TodoStatus } from './schema.js'

// Events (now in plugin.ts)
export { todoEvents } from './plugin.js'
export type { TodoCreatedEvent, TodoDeletedEvent, TodoUpdatedEvent } from './plugin.js'
