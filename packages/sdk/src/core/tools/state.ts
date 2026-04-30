import z4 from 'zod/v4'
import { agentIdSchema } from '~/core/agents/schema.js'
import type { ToolResultContent } from '~/core/llm/llm-log-types.js'
import { createEventsFactory } from '../events/types.js'
import { toolCallIdSchema } from './schema.js'

export const toolEvents = createEventsFactory({
	events: {
		tool_started: z4.object({
			agentId: agentIdSchema,
			toolCallId: toolCallIdSchema,
			toolName: z4.string(),
			input: z4.custom<Record<string, unknown>>(),
		}),
		tool_completed: z4.object({
			agentId: agentIdSchema,
			toolCallId: toolCallIdSchema,
			result: z4.custom<ToolResultContent>(),
			workspaceRef: z4.string().optional(),
			sessionRef: z4.string().optional(),
		}),
		tool_failed: z4.object({
			agentId: agentIdSchema,
			toolCallId: toolCallIdSchema,
			error: z4.string(),
			workspaceRef: z4.string().optional(),
			sessionRef: z4.string().optional(),
		}),
	},
})

export type ToolStartedEvent = (typeof toolEvents)['Events']['tool_started']
export type ToolCompletedEvent = (typeof toolEvents)['Events']['tool_completed']
export type ToolFailedEvent = (typeof toolEvents)['Events']['tool_failed']
