/**
 * Skills domain types
 *
 * Skills are reusable instruction sets that agents can load on-demand.
 * Only metadata (name + description) is shown in system prompt;
 * full content is loaded via use_skill tool.
 */

import z from 'zod/v4'

// ============================================================================
// Branded ID
// ============================================================================

/** SkillId schema - validates any string and brands as SkillId. */
export const skillIdSchema = z.string().brand('SkillId')

/**
 * Branded type for skill IDs.
 * Format: lowercase kebab-case (e.g., "arxiv-search", "research-workflow")
 */
export type SkillId = z.infer<typeof skillIdSchema>

/**
 * Create a SkillId from a string.
 */
export const SkillId = (id: string): SkillId => id as SkillId

// ============================================================================
// Skill Metadata
// ============================================================================

/**
 * Metadata about an available skill.
 * Either discovered at session init from SKILL.md files (`source: 'file'`)
 * or contributed inline by the preset (`source: 'inline'`).
 */
export type SkillMetadata =
	| {
		source: 'file'
		/** Unique identifier (from frontmatter name field) */
		id: SkillId
		/** Human-readable name */
		name: string
		/** Short description shown in system prompt */
		description: string
		/** Absolute path to the SKILL.md file */
		sourcePath: string
	}
	| {
		source: 'inline'
		id: SkillId
		name: string
		description: string
		/** Full skill body, already provided by the preset */
		content: string
	}

// ============================================================================
// Loaded Skill
// ============================================================================

/**
 * A skill that has been loaded into an agent's context.
 * Stored in AgentState and injected as system message before inference.
 */
export interface LoadedSkill {
	/** Skill identifier */
	id: SkillId
	/** Skill name */
	name: string
	/** Timestamp when the skill was loaded */
	loadedAt: number
}

/** Loaded skill content used only while creating the agent preamble. */
export interface LoadedSkillContent extends LoadedSkill {
	content: string
}

// ============================================================================
// Skills Configuration
// ============================================================================

/**
 * Skills configuration for a preset.
 */
export interface SkillsConfig {
	/** Directories to scan for skills (relative to preset or absolute paths) */
	sources: string[]
}
