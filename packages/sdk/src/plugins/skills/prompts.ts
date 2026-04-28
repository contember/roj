/**
 * Skills Prompt Sections - Build prompt sections for skill metadata and loaded skills.
 */

import type { LoadedSkill, SkillMetadata } from './schema.js'

// ============================================================================
// Available Skills Section
// ============================================================================

/**
 * Build the "Available Skills" section for the system prompt.
 * Lists skill names and descriptions, instructing agent to use use_skill tool.
 *
 * @param skills - Array of discovered skill metadata
 * @returns Formatted section string, or empty string if no skills
 */
export function buildSkillsSection(skills: SkillMetadata[]): string {
	if (skills.length === 0) {
		return ''
	}

	const lines = [
		'## Available Skills',
		'',
		'The following skills provide specialized instructions you can load on-demand.',
		'Use the `use_skill` tool to load the full instructions when needed.',
		'',
	]

	for (const skill of skills) {
		lines.push(`- **${skill.name}**: ${skill.description}`)
	}

	return lines.join('\n')
}

// ============================================================================
// Loaded Skills Content
// ============================================================================

/**
 * Format loaded skills as content to be injected before inference.
 * Each skill is wrapped in a clear section header.
 *
 * @param loadedSkills - Array of skills loaded into agent context
 * @returns Formatted string with all loaded skill content
 */
export function formatLoadedSkills(loadedSkills: LoadedSkill[]): string {
	if (loadedSkills.length === 0) {
		return ''
	}

	const sections: string[] = []

	for (const skill of loadedSkills) {
		sections.push(`<loaded-skill name="${skill.name}">
${skill.content}
</loaded-skill>`)
	}

	return sections.join('\n\n')
}

/**
 * Build a system message containing all loaded skills.
 * Returns null if no skills are loaded.
 *
 * @param loadedSkills - Array of skills loaded into agent context
 * @returns System message content or null
 */
export function buildLoadedSkillsMessage(loadedSkills: LoadedSkill[]): string | null {
	if (loadedSkills.length === 0) {
		return null
	}

	const content = formatLoadedSkills(loadedSkills)

	return `## Loaded Skills

The following skills have been loaded into your context. Follow these instructions when performing related tasks.

${content}`
}
