/**
 * Agent configuration types for Roj presets
 */

import z from 'zod/v4'
import type { DebounceCallback } from '~/core/agents/debounce.js'
import type { LLMMiddleware } from '~/core/llm/middleware.js'
import { ModelId } from '~/core/llm/schema.js'
import type { AgentPluginConfig } from '~/core/plugins/plugin-builder.js'
import type { ToolDefinition } from '~/core/tools'
import type { ServiceConfig } from '~/plugins/services/schema.js'

// ============================================================================
// Base Agent Config
// ============================================================================

/**
 * User communication mode for agents.
 * - 'tool': Use tell_user/ask_user tools only (default)
 * - 'xml': Use <user> tags in response content
 * - 'both': Support both tools and <user> tags
 */
export type UserCommunicationMode = 'tool' | 'xml' | 'both'

/**
 * Base configuration shared by all agent types.
 */
export interface BaseAgentConfig<TInput = unknown> {
	/** System prompt for the agent */
	system: string
	/** LLM model for this agent */
	model: ModelId
	// ToolDefinition<any> required: ToolDefinition is contravariant in TInput,
	// so ToolDefinition<SpecificInput> is not assignable to ToolDefinition<unknown>
	/** Available tools for the agent */
	tools?: ToolDefinition<any>[]
	/** Names of agents this agent can spawn */
	agents?: string[]
	/** Per-plugin agent-level configs */
	plugins?: AgentPluginConfig[]
	/** Debounce time in ms before processing mailbox. Default: 500ms */
	debounceMs?: number
	/** Custom debounce callback for dynamic processing decisions */
	debounceCallback?: DebounceCallback
	/** Interval in ms for checking debounce callback (default: 100) */
	checkIntervalMs?: number
	/** User communication mode. Default: 'tool' */
	userCommunication?: UserCommunicationMode
	/** Optional Zod schema for typed agent input validation */
	input?: z.ZodType<TInput>
	/** Service configurations for this agent (auto-wired to services plugin) */
	services?: ServiceConfig[]
	/** LLM middleware chain applied per-agent (runs after preset-level middleware) */
	llmMiddleware?: LLMMiddleware[]
}

/**
 * Agent definition - configuration for a spawnable agent.
 * Extends BaseAgentConfig with a name field.
 */
export interface AgentDefinition<TInput = unknown> extends BaseAgentConfig<TInput> {
	name: string
}

/**
 * Agent definition for use in Preset arrays.
 * Uses 'any' to allow mixing typed and untyped agents in the same array.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentDefinition = AgentDefinition<any>

/**
 * Orchestrator configuration - same as BaseAgentConfig.
 */
export type OrchestratorConfig<TInput = unknown> = BaseAgentConfig<TInput>

/**
 * Response format preferences for communicator
 */
export interface ResponseFormat {
	/** Preferred language */
	language?: string
	/** Tone (formal, casual, friendly, professional) */
	tone?: 'formal' | 'casual' | 'friendly' | 'professional'
	/** Include thinking/reasoning in responses */
	showReasoning?: boolean
	/** Maximum response length hint */
	maxLengthHint?: number
}

/**
 * Communicator configuration (optional communication agent).
 * Extends base config with optional tools (defaults provided) and response format.
 */
export interface CommunicatorConfig extends BaseAgentConfig {
	/** Response format preferences (communicator-specific) */
	responseFormat?: ResponseFormat
}
