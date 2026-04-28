/**
 * Prompts module - centralized location for base prompts and prompt builders.
 *
 * This module consolidates prompt templates that are used across the codebase.
 * Preset-specific prompts remain in their respective preset files.
 */

export {
	// Agent briefings
	AGENT_BASE_BRIEFING,
	CHILD_AGENT_BRIEFING,
	COMMUNICATOR_BRIEFING,
	// Context compaction prompts
	CONTEXT_SUMMARY_PROMPT,
	CONTEXT_SUMMARY_WRAPPER,
	ENTRY_AGENT_BRIEFING,
	ORCHESTRATOR_BRIEFING,
	REASONING_INSTRUCTIONS,
	// Response format instructions
	TONE_INSTRUCTIONS,
} from './base.js'

export {
	type AgentRole,
	// Factory functions
	buildEnvironmentSection,
	buildSystemPrompt,
	// Builder
	PromptBuilder,
	type PromptEnvironment,
	// Types
	type ToneType,
	wrapContextSummary,
} from './builder.js'

export { agentVars, processPromptMacros } from './macros.js'
