/**
 * WorkerDefinition - defines the interface for worker types.
 *
 * Each worker type defines:
 * 1. State shape - worker-specific state structure
 * 2. Event types - worker-specific events
 * 3. Reducer - how events change state
 * 4. Execute - main worker logic
 * 5. Commands - optional command definitions for typed tools
 */

import type z from 'zod/v4'
import type { ToolResultContent } from '~/core/llm/llm-log-types.js'
import type { Result } from '~/lib/utils/result.js'
import type { WorkerContext } from './context.js'
import { WorkerCommand, WorkerError, WorkerResult } from './worker.js'

/**
 * Base worker configuration.
 * Describes a worker type's metadata and state management.
 * Agent-server's WorkerDefinition adds typed generics and execution logic.
 */
export interface WorkerConfig {
	/** Unique worker type identifier */
	type: string
	/** Human-readable description */
	description: string
	/** Zod schema for config validation */
	configSchema: z.ZodType<unknown>
	/** Optional command definitions for typed tools */
	commands?: Record<string, WorkerCommandConfig>
	/** Create initial state from config (method syntax for bivariance) */
	initialState(config: unknown): unknown
	/** Reducer for worker-specific events (method syntax for bivariance) */
	reduce(state: unknown, event: { type: string; [key: string]: unknown }): unknown
}

/**
 * Configuration for a worker command.
 * Used to generate typed tools for worker control.
 */
export interface WorkerCommandConfig {
	description: string
	schema: z.ZodType<unknown>
}

/**
 * Definition for a worker command.
 * Used to generate typed tools for worker control.
 * Extends WorkerCommandConfig from shared.
 */
export interface WorkerCommandDefinition<TArgs = unknown> extends WorkerCommandConfig {
	/** Zod schema for command arguments validation */
	schema: z.ZodType<TArgs>
}

// ============================================================================
// WorkerDefinition Interface
// ============================================================================

/**
 * Base sub-event type that all worker-specific events must extend.
 */
export interface WorkerSubEvent {
	type: string
	[key: string]: unknown
}

/**
 * Worker definition - describes a worker type's behavior.
 * Structurally compatible with WorkerConfig from shared (when default type params are used).
 * Adds typed generics and execution logic.
 *
 * @template TConfig - Worker configuration type
 * @template TState - Worker state type
 * @template TSubEvent - Worker-specific event type
 */
export interface WorkerDefinition<
	TConfig = unknown,
	TState = unknown,
	TSubEvent extends WorkerSubEvent = WorkerSubEvent,
> {
	/** Unique worker type identifier */
	type: string

	/** Human-readable description */
	description: string

	/** Zod schema for config validation */
	configSchema: z.ZodType<TConfig>

	/** Optional command definitions for generating typed tools */
	commands?: Record<string, WorkerCommandDefinition>

	/** Create initial state from config */
	initialState(config: TConfig): TState

	/** Reducer for worker-specific events */
	reduce(state: TState, event: TSubEvent): TState

	/**
	 * Main execution logic.
	 * The worker runs until completion, failure, or cancellation.
	 */
	execute(
		config: TConfig,
		context: WorkerContext<TState, TSubEvent>,
	): Promise<Result<WorkerResult, WorkerError>>

	/**
	 * Optional: handle commands from agent.
	 * Commands allow agents to control running workers.
	 * Returns ToolResultContent for the agent to receive.
	 */
	handleCommand?(
		command: WorkerCommand,
		context: WorkerContext<TState, TSubEvent>,
	): Promise<Result<ToolResultContent, WorkerError>>

	/**
	 * Optional: summarize state for status reporting.
	 * When provided, worker_status tool returns this summary instead of the full state.
	 * Use this to avoid sending large state objects (e.g. full crawl results) into LLM context.
	 */
	summarizeState?(state: TState): unknown
}

// ============================================================================
// Helper to create WorkerDefinition
// ============================================================================

/**
 * Create a worker definition with proper typing.
 *
 * @param type - Unique worker type identifier
 * @param description - Human-readable description
 * @param configSchema - Zod schema for config validation
 * @param definition - Worker behavior definition
 */
export function createWorkerDefinition<
	TConfig,
	TState,
	TSubEvent extends WorkerSubEvent,
>(
	type: string,
	description: string,
	configSchema: z.ZodType<TConfig>,
	definition: {
		commands?: Record<string, WorkerCommandDefinition>
		initialState: (config: TConfig) => TState
		reduce: (state: TState, event: TSubEvent) => TState
		execute: (
			config: TConfig,
			ctx: WorkerContext<TState, TSubEvent>,
		) => Promise<Result<WorkerResult, WorkerError>>
		handleCommand?: (
			cmd: WorkerCommand,
			ctx: WorkerContext<TState, TSubEvent>,
		) => Promise<Result<ToolResultContent, WorkerError>>
		summarizeState?: (state: TState) => unknown
	},
): WorkerDefinition<TConfig, TState, TSubEvent> {
	return {
		type,
		description,
		configSchema,
		...definition,
	}
}
