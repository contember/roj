/**
 * Type-safe preset builder for Roj SDK.
 *
 * Replaces string-based cross-references (spawnableAgents)
 * with object references, catching typos and renames at compile time.
 *
 * `createPreset` recursively collects agents from the orchestrator tree.
 */

import type { Preset } from '~/core/preset/index.js'
import type { AgentDefinition, AnyAgentDefinition, BaseAgentConfig, OrchestratorConfig } from '../agents/config.js'

// ============================================================================
// Helper types
// ============================================================================

interface ObjectRefs {
	agents?: AnyAgentDefinition[]
}

/**
 * Replace string ref fields with short object-ref fields.
 * `agents: string[]` → `agents: AnyAgentDefinition[]`
 */
type WithObjectRefs<T> =
	& Omit<T, 'spawnableAgents' | 'agents'>
	& ObjectRefs

// ============================================================================
// Public input types
// ============================================================================

/** Input type for defineAgent - uses object refs instead of string names */
export type DefineAgentInput<TInput = unknown> = WithObjectRefs<AgentDefinition<TInput>>

/** Input type for createOrchestrator - uses object refs instead of string names */
export type CreateOrchestratorInput = WithObjectRefs<BaseAgentConfig>

/** Input type for createPreset - agents are auto-collected from the tree */
export type CreatePresetInput = Omit<Preset, 'agents'>

// ============================================================================
// Internal: ref storage & resolution
// ============================================================================

/** Stores original object refs for each resolved config, keyed by identity */
const refStore = new WeakMap<object, ObjectRefs>()

function resolveAndStore<T extends object>(
	refs: ObjectRefs,
	resolved: T,
): T {
	refStore.set(resolved, refs)
	return resolved
}

interface ResolvedRefs {
	agents: string[]
}

function resolveRefs(refs: ObjectRefs): ResolvedRefs {
	return {
		agents: (refs.agents ?? []).map((a) => a.name),
	}
}

/** Recursively collect agents from a config node */
export function collectFromTree(root: object): { agents: AnyAgentDefinition[] } {
	const agents = new Set<AnyAgentDefinition>()

	function visit(node: object) {
		const refs = refStore.get(node)
		if (!refs) return

		for (const agent of refs.agents ?? []) {
			if (!agents.has(agent)) {
				agents.add(agent)
				visit(agent)
			}
		}
	}

	visit(root)
	return { agents: [...agents] }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Define an agent with type-safe object references.
 *
 * Accepts `agents`  as object references
 * and resolves them to string names for the runtime.
 */
export function defineAgent<TInput = unknown>(input: DefineAgentInput<TInput>): AgentDefinition<TInput> {
	const { agents, ...rest } = input
	return resolveAndStore({ agents }, { ...rest, ...resolveRefs({ agents }) })
}

/**
 * Create an orchestrator config with type-safe object references.
 *
 * Accepts `agents` as object references
 * and resolves them to string names for the runtime.
 */
export function createOrchestrator(input: CreateOrchestratorInput): OrchestratorConfig {
	const { agents, ...rest } = input
	return resolveAndStore({ agents }, { ...rest, ...resolveRefs({ agents }) })
}
