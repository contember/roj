import type { AnyAgentDefinition, CommunicatorConfig, OrchestratorConfig } from '~/core/agents/config.js'
import type { LLMMiddleware } from '~/core/llm/middleware.js'
import type { SessionPluginConfig } from '~/core/plugins/plugin-builder.js'
import type { CreatePresetInput } from './preset-builder.js'
import { collectFromTree } from './preset-builder.js'

/**
 * Preset - complete configuration for a Roj session
 */
export interface PresetDefinition {
	id: string
	name: string
	description?: string

	/** Default workspace directory path. Can be overridden per session. */
	workspaceDir?: string

	/** When true, agents see virtual paths (/home/user/session, /home/user/workspace) instead of real filesystem paths */
	sandboxed?: boolean

	/**
	 * Session-level plugin configurations.
	 * Created via `pluginDefinition.configure(config)`.
	 */
	plugins?: SessionPluginConfig[]

	/** Orchestrator configuration (always exists) */
	orchestrator: OrchestratorConfig

	/**
	 * Communication agent configuration.
	 * When present, user messages are routed through communicator first.
	 * When absent, messages go directly to orchestrator.
	 */
	communicator?: CommunicatorConfig

	/** Definitions of spawnable agents (accepts both typed and untyped agents) */
	agents: AnyAgentDefinition[]

	/** LLM middleware chain applied to all agents in this preset (runs before agent-level middleware) */
	llmMiddleware?: LLMMiddleware[]

	/**
	 * Platform resource slugs to inject into sessions by default.
	 * The init workflow resolves these slugs to resource files and injects them
	 * into the workspace when no explicit resourceIds are provided.
	 */
	defaultResourceSlugs?: string[]
}

/**
 * Create a preset with automatic collection.
 *
 * Recursively walks the orchestrator (and communicator) tree to collect
 * all agents. Then validates with `validatePreset()`.
 *
 * @throws Error if preset validation fails
 */
export function createPreset(input: CreatePresetInput): PresetDefinition {
	const collected = collectFromTree(input.orchestrator)

	if (input.communicator) {
		const commCollected = collectFromTree(input.communicator)
		for (const a of commCollected.agents) {
			if (!collected.agents.includes(a)) collected.agents.push(a)
		}
	}

	const preset: PresetDefinition = {
		...input,
		agents: collected.agents,
	}

	const errors = validatePreset(preset)
	if (errors.length > 0) {
		throw new Error(`Invalid preset "${preset.id}":\n${errors.map((e) => `  - ${e}`).join('\n')}`)
	}

	return preset
}

/**
 * Validates a preset configuration, checking that all referenced agents, and services exist.
 * @param preset The preset to validate
 * @returns Array of error messages (empty if valid)
 */
export const validatePreset = (preset: PresetDefinition): string[] => {
	const errors: string[] = []

	// Collect all defined agent names
	const agentNames = new Set(preset.agents.map((a) => a.name))

	// Check orchestrator spawnable agents
	for (const name of preset.orchestrator.agents ?? []) {
		if (!agentNames.has(name)) {
			errors.push(`Orchestrator references unknown agent: ${name}`)
		}
	}

	// Check each agent's spawnable agents and workers
	for (const agent of preset.agents) {
		for (const name of agent.agents ?? []) {
			if (!agentNames.has(name)) {
				errors.push(`Agent '${agent.name}' references unknown agent: ${name}`)
			}
		}
	}

	return errors
}
