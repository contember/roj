/**
 * Prompt builder pattern for constructing system prompts dynamically.
 */

import {
	AGENT_BASE_BRIEFING,
	CHILD_AGENT_BRIEFING,
	COMMUNICATOR_BRIEFING,
	CONTEXT_SUMMARY_WRAPPER,
	ENTRY_AGENT_BRIEFING,
	ORCHESTRATOR_BRIEFING,
	TONE_INSTRUCTIONS,
} from './base.js'

// ============================================================================
// Types
// ============================================================================

export type ToneType = keyof typeof TONE_INSTRUCTIONS

/**
 * Agent role determines which briefing to include in the system prompt.
 * - "entry": Orchestrator without communicator (talks to user directly)
 * - "orchestrator": Orchestrator with communicator (talks to communicator, not user)
 * - "child": Spawned by parent, reports results back
 * - "communicator": Handles user communication, relays to orchestrator
 */
export type AgentRole = 'entry' | 'orchestrator' | 'child' | 'communicator'

// ============================================================================
// Prompt Builder
// ============================================================================

/**
 * Builder for constructing prompts with various sections.
 */
export class PromptBuilder {
	private sections: string[] = []

	/**
	 * Add a section to the prompt.
	 */
	add(content: string | undefined | null): this {
		if (content) {
			this.sections.push(content)
		}
		return this
	}

	/**
	 * Add a section only if a condition is met.
	 */
	addIf(condition: boolean, content: string): this {
		if (condition) {
			this.sections.push(content)
		}
		return this
	}

	/**
	 * Add multiple sections at once, filtering out empty values.
	 */
	addAll(...contents: (string | undefined | null)[]): this {
		for (const content of contents) {
			this.add(content)
		}
		return this
	}

	/**
	 * Build the final prompt by joining sections with double newlines.
	 */
	build(): string {
		return this.sections.filter(Boolean).join('\n\n').trim()
	}

	/**
	 * Reset the builder for reuse.
	 */
	reset(): this {
		this.sections = []
		return this
	}
}

// ============================================================================
// System Prompt Builder
// ============================================================================

/**
 * Environment info for system prompt injection.
 */
export interface PromptEnvironment {
	/** Path the agent sees for session directory */
	sessionPath: string
	/** Path the agent sees for workspace directory (optional) */
	workspacePath?: string
}

/**
 * Build environment section for system prompt.
 */
export function buildEnvironmentSection(env: PromptEnvironment): string {
	const lines = ['## Working Environment', '']
	lines.push('You have access to the following directories:')
	lines.push('')
	lines.push(`- \`${env.sessionPath}\` — Your session directory. Use this for plans, notes, temporary files, scripts, and any artifacts you create.`)

	if (env.workspacePath) {
		lines.push(
			`- \`${env.workspacePath}\` — The workspace directory. This contains the project files. Your final outputs (code, assets) should be written here.`,
		)
	} else {
		lines.push('')
		lines.push('No workspace directory is configured for this session.')
	}

	lines.push('')
	lines.push('Use these paths consistently across all tools (file operations, shell commands, etc.).')

	return lines.join('\n')
}

/**
 * Build a complete system prompt for an agent.
 *
 * Structure:
 * 1. BASE BRIEFING - For all agents, technical minimum
 * 2. ROLE BRIEFING - Entry agent vs Child agent vs Communicator
 * 3. ENVIRONMENT - Working directories
 * 4. CUSTOM PROMPT - From preset, purely role/tasks without tech details
 *
 * @param role - Agent role: "entry", "child", or "communicator"
 * @param customPrompt - Custom prompt from preset (role/tasks only)
 * @param environment - Optional environment info for directory roots
 */
export function buildSystemPrompt(
	role: AgentRole,
	customPrompt: string,
	environment?: PromptEnvironment,
): string {
	const builder = new PromptBuilder()

	builder.add(AGENT_BASE_BRIEFING)

	switch (role) {
		case 'entry':
			builder.add(ENTRY_AGENT_BRIEFING)
			break
		case 'orchestrator':
			builder.add(ORCHESTRATOR_BRIEFING)
			break
		case 'child':
			builder.add(CHILD_AGENT_BRIEFING)
			break
		case 'communicator':
			builder.add(COMMUNICATOR_BRIEFING)
			break
	}

	if (environment) {
		builder.add(buildEnvironmentSection(environment))
	}

	builder.add(customPrompt)

	let result = builder.build()

	// Replace template variables with actual paths
	if (environment) {
		result = result.replaceAll('{{sessionDir}}', environment.sessionPath)
		if (environment.workspacePath) {
			result = result.replaceAll('{{workspaceDir}}', environment.workspacePath)
		}
	}

	return result
}

// ============================================================================
// Context Summary Builder
// ============================================================================

/**
 * Wrap a summary in the standard context summary format.
 * @param summary - The summary text
 * @param historyPath - Optional path to offloaded full history
 */
export function wrapContextSummary(summary: string, historyPath?: string): string {
	const historyNote = historyPath
		? `The full conversation history has been saved to ${historyPath} if you need details.\n\n`
		: ''
	return CONTEXT_SUMMARY_WRAPPER.replace('{summary}', historyNote + summary)
}
