/**
 * Validation of session overrides against the preset they target.
 *
 * Overrides are keyed by agent definition name, which makes a typo silent: the
 * entry simply never matches and the agent quietly keeps the preset's model.
 * Every entry point that accepts an override patch rejects unknown names instead.
 */

import { COMMUNICATOR_ROLE, ORCHESTRATOR_ROLE } from '~/core/agents/agent-roles.js'
import type { SessionOverridesPatch } from '~/core/sessions/state.js'
import type { PresetDefinition } from './config.js'

/** Every definition name an override may target, in preset order. */
export const knownDefinitionNames = (preset: PresetDefinition): string[] => [
	ORCHESTRATOR_ROLE,
	...(preset.communicator ? [COMMUNICATOR_ROLE] : []),
	...preset.agents.map(agent => agent.name),
]

/** Names in the patch that the preset does not define. Empty when the patch is valid. */
export const unknownOverrideTargets = (preset: PresetDefinition, patch: SessionOverridesPatch): string[] => {
	const known = new Set(knownDefinitionNames(preset))
	return Object.keys(patch.agents ?? {}).filter(name => !known.has(name))
}
