/**
 * LLM domain types and schemas
 *
 * Contains all types related to LLM:
 * - Branded ID types and constructors (LLMCallId, ModelId)
 * - LLM response types
 * - Zod schemas for validation
 */

import { uuidv7 } from 'uuidv7'
import z from 'zod/v4'
import type { LLMToolCall } from './state.js'

// ============================================================================
// LLMCallId - Branded type
// ============================================================================

/** LLMCallId schema - validates any string and brands as LLMCallId. */
export const llmCallIdSchema = z.string().brand('LLMCallId')

/** Branded LLMCallId type */
export type LLMCallId = z.infer<typeof llmCallIdSchema>

/** Constructor for LLMCallId */
export const LLMCallId = (id: string): LLMCallId => id as LLMCallId

/** Generate a new LLMCallId (UUIDv7) */
export const generateLLMCallId = (): LLMCallId => LLMCallId(uuidv7())

// ============================================================================
// LLMCallId - Zod schemas
// ============================================================================

// ============================================================================
// ModelId - Branded type
// ============================================================================

/** ModelId schema - validates any string and brands as ModelId. */
export const modelIdSchema = z.string().brand('ModelId')

/** Branded ModelId type */
export type ModelId = z.infer<typeof modelIdSchema>

/** Constructor for ModelId */
export const ModelId = (id: string): ModelId => id as ModelId

// LLMResponse, LLMMetrics, and LLMToolCall are now defined in ./state.ts
