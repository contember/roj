import z from 'zod/v4'
import { ToolResultContent } from '~/core/llm/llm-log-types.js'
import { SessionEnvironment } from '~/core/sessions/session-environment'
import type { Logger } from '~/lib/logger/logger.js'
import { Err, Ok, Result } from '~/lib/utils/result.js'
import { ToolContext } from './context.js'
import { ToolDefinition } from './definition.js'

export type { SessionEnvironment }

// ============================================================================
// Tool error
// ============================================================================

/**
 * Tool execution error
 */
export interface ToolError {
	message: string
	recoverable: boolean
	details?: unknown
}

// ============================================================================
// ToolExecutor
// ============================================================================

/**
 * ToolExecutor - executes tools with logging and error handling
 */
export class ToolExecutor {
	constructor(private readonly logger: Logger) {}

	/**
	 * Execute a tool with given input.
	 * Validates input against the tool's schema before execution.
	 */
	async execute(
		tool: ToolDefinition<any>,
		input: unknown,
		context: ToolContext,
	): Promise<Result<ToolResultContent, ToolError>> {
		const startTime = Date.now()

		// Validate input with Zod schema
		const validation = tool.input.safeParse(input)
		if (!validation.success) {
			const issues = validation.error.issues
				.map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`)
				.join('; ')

			this.logger.warn('Tool input validation failed', {
				sessionId: context.sessionId,
				agentId: context.agentId,
				tool: tool.name,
				issues,
			})

			return Err({
				message: `Invalid tool input: ${issues}`,
				recoverable: false,
				details: validation.error.issues,
			})
		}

		const validatedInput = validation.data

		this.logger.debug('Executing tool', {
			sessionId: context.sessionId,
			agentId: context.agentId,
			tool: tool.name,
			input: validatedInput,
		})

		try {
			const result = await tool.execute(validatedInput, context)
			const durationMs = Date.now() - startTime

			if (result.ok) {
				this.logger.debug('Tool completed', {
					sessionId: context.sessionId,
					agentId: context.agentId,
					tool: tool.name,
					durationMs,
				})
				return Ok(result.value)
			} else {
				this.logger.warn('Tool failed', {
					sessionId: context.sessionId,
					agentId: context.agentId,
					tool: tool.name,
					error: result.error.message,
					durationMs,
				})
				return result
			}
		} catch (error) {
			const durationMs = Date.now() - startTime

			this.logger.error(
				'Tool threw exception',
				error instanceof Error ? error : undefined,
				{
					sessionId: context.sessionId,
					agentId: context.agentId,
					tool: tool.name,
					durationMs,
				},
			)

			return Err({
				message: error instanceof Error ? error.message : String(error),
				recoverable: false,
			})
		}
	}
}
