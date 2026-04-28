/**
 * Tool domain types and schemas
 *
 * Contains all types related to tools:
 * - Branded ID type and constructor
 * - Tool definition types
 * - Zod schemas for validation
 */

import { uuidv7 } from 'uuidv7'
import z from 'zod/v4'
import type { ToolResultContent } from '~/core/llm/llm-log-types.js'
import { ToolContext } from './context'

// ============================================================================
// ToolCallId - Branded type
// ============================================================================

/** ToolCallId schema - validates any string and brands as ToolCallId. */
export const toolCallIdSchema = z.string().brand('ToolCallId')

/** Branded ToolCallId type */
export type ToolCallId = z.infer<typeof toolCallIdSchema>

/** Constructor for ToolCallId */
export const ToolCallId = (id: string): ToolCallId => id as ToolCallId

/** Generate a new ToolCallId (UUIDv7) */
export const generateToolCallId = (): ToolCallId => ToolCallId(uuidv7())

// ============================================================================
// ToolCallId - Zod schemas
// ============================================================================

// ============================================================================
// Tool types
// ============================================================================
/**
 * Tool call in agent state.
 */
export interface ToolCall {
	id: ToolCallId
	name: string
	input: unknown
}

/**
 * Tool result in agent state.
 */
export interface ToolResult {
	toolCallId: ToolCallId
	result: unknown
	isError: boolean
}

/**
 * Pending tool result awaiting LLM processing.
 * Stored after tool_completed/tool_failed, moved to conversationHistory by inference_completed.
 */
export interface PendingToolResult {
	toolCallId: ToolCallId
	toolName: string
	timestamp: number
	isError: boolean
	content: ToolResultContent
}

export type ToolOkResponse = {
	ok: true
	value: ToolResultContent
}

export type ToolErrorResponse = {
	ok: false
	error: { message: string; recoverable: boolean; details?: unknown }
}

export type ToolResponse = ToolOkResponse | ToolErrorResponse

export type ToolExecutionCallback<TInput = unknown> = (input: TInput, context: ToolContext) => Promise<ToolResponse>
