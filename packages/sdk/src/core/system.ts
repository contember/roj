/**
 * System — Composition Root
 *
 * createSystem() is the main entry point that:
 * - Accepts all plugin definitions and infrastructure dependencies
 * - Composes plugins, creates SessionManager internally
 * - Exposes typed method registry for RPC type inference
 */

import type z4 from 'zod/v4'
import type { Logger } from '~/lib/logger/logger.js'
import type { Platform } from '~/platform/index.js'
import type { PortPool } from '~/plugins/services/port-pool.js'
import type { PreprocessorRegistry } from '~/plugins/uploads/preprocessor.js'
import type { EventStore } from './events/event-store.js'
import type { FileStore } from './file-store/types.js'
import type { LLMLogger } from './llm/logger.js'
import type { LLMProvider } from './llm/provider.js'
import type { PluginDefinition } from './plugins/plugin-builder.js'
import type { Preset } from './preset/index.js'
import { SessionManager } from './sessions/session-manager.js'
import type { UserOutputCallback } from './sessions/session.js'
import type { ToolExecutor } from './tools/executor.js'

// ============================================================================
// Method schema types
// ============================================================================

export type MethodSchema = { input: z4.ZodType; output: z4.ZodType }

/**
 * Extract manager method schemas from a single PluginDefinition.
 * Uses indexed access on type brands (P['name'], P['_managerMethods'])
 * instead of conditional `infer` — avoids expensive pattern matching on 5-param generic.
 */
type ManagerMethodSchemas<P extends PluginDefinition<string, any, any, any, any>> = {
	[K in string & keyof NonNullable<P['_managerMethods']> as `${P['name']}.${K}`]: NonNullable<P['_managerMethods']>[K]
}

/**
 * Extract session-level method schemas from a single PluginDefinition.
 * The `__session` marker enables RpcInput<M> to automatically add `sessionId: string`
 * for session methods (the RPC dispatcher requires sessionId for routing).
 */
type SessionMethodSchemas<P extends PluginDefinition<string, any, any, any, any>> = {
	[K in string & keyof NonNullable<P['_methods']> as `${P['name']}.${K}`]: NonNullable<P['_methods']>[K] & { __session: true }
}

/** Merge manager + session method schemas from a single plugin into one object */
type PluginSchemas<P extends PluginDefinition<string, any, any, any, any>> = ManagerMethodSchemas<P> & SessionMethodSchemas<P>

/**
 * Merge method schemas from an array of PluginDefinitions.
 * Recursive tuple traversal — directly accumulates intersections without
 * UnionToIntersection (which uses expensive contravariant inference over distributive conditionals).
 */
type MergePluginSchemas<TPlugins extends readonly PluginDefinition<string, any, any, any, any>[], Acc = {}> = TPlugins extends readonly [
	infer Head extends PluginDefinition<string, any, any, any, any>,
	...infer Tail extends readonly PluginDefinition<string, any, any, any, any>[],
] ? MergePluginSchemas<Tail, Acc & PluginSchemas<Head>>
	: Acc

export type AllMethodSchemas<TPlugins extends readonly PluginDefinition<string, any, any, any, any>[]> = MergePluginSchemas<TPlugins>

// ============================================================================
// Plugins accessor type
// ============================================================================

/**
 * Maps an array of PluginDefinitions to a record keyed by plugin name.
 * Enables `system.plugins.todo` → typed PluginDefinition accessor.
 */
type PluginsAccessor<TPlugins extends readonly PluginDefinition<string, any, any, any, any>[]> = {
	[P in TPlugins[number] as P extends PluginDefinition<infer N, any, any, any, any> ? N : never]: P
}

// ============================================================================
// System interface
// ============================================================================

export interface System<
	TMethodSchemas = Record<string, MethodSchema>,
	TPlugins extends readonly PluginDefinition<string, any, any, any, any>[] = readonly PluginDefinition[],
> {
	/** SessionManager wrapped internally */
	sessionManager: SessionManager

	/** Typed method registry (inferred from all plugins) */
	methodSchemas: TMethodSchemas

	/** Typed accessor for all registered plugins */
	plugins: PluginsAccessor<TPlugins>

	/** Shutdown all sessions */
	shutdown(): Promise<void>

	/** Load all sessions from event store */
	loadAllSessions(): Promise<void>
}

// ============================================================================
// createSystem options
// ============================================================================

export interface CreateSystemOptions<TPlugins extends readonly PluginDefinition<string, any, any, any, any>[]> {
	/** All plugin definitions */
	plugins: TPlugins

	// Infrastructure dependencies
	eventStore: EventStore
	llmProvider: LLMProvider
	/** Named provider instances for middleware routing */
	llmProviders?: ReadonlyMap<string, LLMProvider>
	toolExecutor: ToolExecutor
	presets: Map<string, Preset>
	logger: Logger
	basePath: string
	dataFileStore: FileStore
	onUserOutput?: UserOutputCallback
	preprocessorRegistry?: PreprocessorRegistry
	llmLogger?: LLMLogger
	portPool?: PortPool
	/** Host-environment adapters (filesystem, process). */
	platform: Platform
}

// ============================================================================
// createSystem
// ============================================================================

export function createSystem<const TPlugins extends readonly PluginDefinition<string, any, any, any, any>[]>(
	options: CreateSystemOptions<TPlugins>,
): System<AllMethodSchemas<TPlugins>, TPlugins> {
	const {
		plugins,
		eventStore,
		llmProvider,
		llmProviders,
		toolExecutor,
		presets,
		logger,
		basePath,
		dataFileStore,
		onUserOutput,
		preprocessorRegistry,
		llmLogger,
		portPool,
		platform,
	} = options

	// Build plugins accessor — typed record keyed by plugin name
	const pluginsAccessor: Record<string, PluginDefinition> = {}
	for (const plugin of plugins) {
		pluginsAccessor[plugin.name] = plugin
	}

	const sessionManager = new SessionManager({
		eventStore,
		llmProvider,
		llmProviders,
		toolExecutor,
		presets,
		logger,
		basePath,
		dataFileStore,
		onUserOutput,
		preprocessorRegistry,
		llmLogger,
		portPool,
		platform,
		systemPlugins: [...plugins],
	})

	// Collect method schemas from all plugins (no .create() needed)
	const methodSchemas: Record<string, MethodSchema> = {}

	for (const plugin of plugins) {
		// Manager methods
		for (const [methodName, methodDef] of Object.entries(plugin.managerMethods)) {
			methodSchemas[`${plugin.name}.${methodName}`] = {
				input: methodDef.input,
				output: methodDef.output,
			}
		}

		// Session methods (available statically on PluginDefinition)
		for (const [methodName, methodDef] of Object.entries(plugin.sessionMethods)) {
			methodSchemas[`${plugin.name}.${methodName}`] = {
				input: methodDef.input,
				output: methodDef.output,
			}
		}
	}

	return {
		sessionManager,
		methodSchemas: methodSchemas as AllMethodSchemas<TPlugins>,
		plugins: pluginsAccessor as PluginsAccessor<TPlugins>,
		async shutdown() {
			await sessionManager.shutdown()
		},
		async loadAllSessions() {
			await sessionManager.loadAllSessions()
		},
	}
}
