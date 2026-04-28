import type { AgentDefinition, CommunicatorConfig } from './config.js'

export function createCommunicatorDefinition(
	config: CommunicatorConfig,
): AgentDefinition {
	return {
		name: '__communicator__',
		system: config.system,
		agents: config.agents ?? [],
		tools: config.tools ?? [],
		debounceMs: config.debounceMs ?? 100, // Fast response for UX
		debounceCallback: config.debounceCallback,
		checkIntervalMs: config.checkIntervalMs,
		model: config.model,
	}
}
