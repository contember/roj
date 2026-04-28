import type { AgentDefinition } from '~/core/agents/config.js'
import { ModelId } from '~/core/llm/schema.js'
import type { AgentPluginConfig, SessionPluginConfig } from '~/core/plugins/plugin-builder.js'
import type { Preset } from '~/core/preset/index.js'

/** AgentDefinition with model optional — defaults to ModelId('mock') in test helpers. */
export type TestAgentDefinition<TInput = unknown> = Omit<AgentDefinition<TInput>, 'model'> & { model?: ReturnType<typeof ModelId> }

/**
 * Create a minimal test preset with sensible defaults.
 * All agents get debounceMs: 0 and model: ModelId('mock').
 */
export function createTestPreset(overrides?: {
	id?: string
	orchestratorSystem?: string
	agents?: TestAgentDefinition[]
	plugins?: SessionPluginConfig[]
	orchestratorPlugins?: AgentPluginConfig[]
}): Preset {
	const agents = overrides?.agents ?? []

	return {
		id: overrides?.id ?? 'test',
		name: 'Test Preset',
		orchestrator: {
			system: overrides?.orchestratorSystem ?? 'You are a test agent.',
			model: ModelId('mock'),
			tools: [],
			agents: agents.map((a) => a.name),
			debounceMs: 0,
			plugins: overrides?.orchestratorPlugins,
		},
		agents: agents.map((a) => ({
			...a,
			model: a.model ?? ModelId('mock'),
			debounceMs: a.debounceMs ?? 0,
		})),
		plugins: overrides?.plugins,
	}
}

/**
 * Create a multi-agent test preset from agent definitions.
 * The orchestrator can spawn all provided agents.
 */
export function createMultiAgentPreset(
	agents: TestAgentDefinition[],
	overrides?: {
		id?: string
		orchestratorSystem?: string
	},
): Preset {
	return createTestPreset({
		...overrides,
		agents,
	})
}
