import z4 from 'zod/v4'
import { ToolExecutionCallback } from './schema'

export type ToolDefinition<TInput = unknown> = {
	name: string
	description: string
	input: z4.ZodType<TInput>
	execute: ToolExecutionCallback<TInput>
}

export function createTool<TInput = unknown>(
	args: ToolDefinition<TInput>,
): ToolDefinition<TInput> {
	return args
}
