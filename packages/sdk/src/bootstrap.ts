/**
 * Bootstrap - Composition Root for Agent Server
 *
 * Creates and wires all services together based on configuration.
 */

import type { EventStore } from '~/core/events/event-store.js'
import { FileEventStore, MemoryEventStore } from '~/core/events/index.js'
import type { FileStore } from '~/core/file-store/types.js'
import { DefaultImageProcessor } from '~/core/image/image-processor.js'
import { VipsImageResizer } from '~/core/image/vips-resizer.js'
import { AnthropicProvider } from '~/core/llm/anthropic.js'
import { LLMLogger, LoggingLLMProvider, MockLLMProvider } from '~/core/llm/index.js'
import { OpenRouterProvider } from '~/core/llm/openrouter.js'
import type { LLMProvider } from '~/core/llm/provider.js'
import { RoutingLLMProvider } from '~/core/llm/routing-provider.js'
import type { RoutableLLMProvider } from '~/core/llm/routing-provider.js'
import type { Preset } from '~/core/preset/index.js'
import type { Platform } from '~/platform/index.js'
import { PreprocessorRegistry } from '~/plugins/uploads/preprocessor.js'
import { ImageClassifierPreprocessor, MarkitdownPreprocessor, ZipPreprocessor } from '~/plugins/uploads/preprocessors/index.js'
import type { Config } from './config.js'
import { SessionFileStore } from './core/file-store/file-store.js'
import type { SessionManager } from './core/sessions/session-manager.js'
import type { UserOutputCallback } from './core/sessions/session.js'
import { type AllMethodSchemas, createSystem, type System } from './core/system.js'
import type { ToolExecutor } from './core/tools/executor.js'
import { ToolExecutor as ToolExecutorImpl } from './core/tools/executor.js'
import { ConsoleLogger, JsonLogger } from './lib/logger/index.js'
import type { Logger } from './lib/logger/logger.js'
import { agentStatusPlugin } from './plugins/agent-status/plugin.js'
import { agentsPlugin } from './plugins/agents/plugin.js'
import { filesystemPlugin } from './plugins/filesystem/index.js'
import { gitStatusPlugin } from './plugins/git-status/index.js'
import { llmDebugPlugin } from './plugins/llm-debug/plugin.js'
import { logsPlugin } from './plugins/logs/index.js'
import { mailboxPlugin } from './plugins/mailbox/plugin.js'
import { servicePlugin } from './plugins/services/plugin.js'
import { PortPool } from './plugins/services/port-pool.js'
import { presetsPlugin, sessionLifecyclePlugin } from './plugins/session-lifecycle/index.js'
import { sessionStatsPlugin } from './plugins/session-stats/index.js'
import { sessionStatePlugin } from './plugins/session-state/plugin.js'
import { resourcesPlugin } from './plugins/resources/plugin.js'
import { uploadsPlugin } from './plugins/uploads/plugin.js'
import { userChatPlugin } from './plugins/user-chat/plugin.js'
import type { RojConfig } from './user-config.js'

/**
 * All built-in plugin definitions passed to createSystem for type inference.
 * These are always registered in every session (see SessionManager.createSessionInstance).
 */
const builtinPlugins = [
	sessionLifecyclePlugin,
	presetsPlugin,
	mailboxPlugin,
	agentsPlugin,
	agentStatusPlugin,
	userChatPlugin,
	uploadsPlugin,
	resourcesPlugin,
	llmDebugPlugin,
	servicePlugin,
	filesystemPlugin,
	logsPlugin,
	sessionStatsPlugin,
	sessionStatePlugin,
	gitStatusPlugin,
] as const

/** Method schemas inferred from all built-in plugins */
export type BuiltinMethodSchemas = AllMethodSchemas<typeof builtinPlugins>

/**
 * Container for all bootstrapped services
 */
export interface Services {
	eventStore: EventStore
	llmProvider: LLMProvider
	/** Named provider instances for middleware routing (e.g. useProvider('anthropic')) */
	llmProviders: ReadonlyMap<string, LLMProvider>
	llmLogger?: LLMLogger
	toolExecutor: ToolExecutor
	logger: Logger
	presets: Map<string, Preset>
	/** FileStore rooted at dataPath for upload/infrastructure file operations */
	dataFileStore: FileStore
	/** Configuration (needed by upload routes) */
	config: Config
	/** Global port pool shared across all sessions */
	portPool: PortPool
	/** Preprocessor registry for upload content extraction */
	preprocessorRegistry: PreprocessorRegistry
	/** Host-environment adapters (filesystem, process). */
	platform: Platform
}

/**
 * Bootstrap all services based on configuration.
 *
 * `platform` provides runtime adapters (fs, process). Callers pass concrete
 * impls from their runtime package (e.g. `createBunPlatform()` from
 * `@roj-ai/sdk/bun-platform`).
 */
export function bootstrap(config: Config, userConfig: RojConfig, platform: Platform): Services {
	const logger = createLogger(config)
	logger.info('Bootstrapping agent server', { persistence: config.persistence, logLevel: config.logLevel })

	const eventStore = config.persistence === 'memory'
		? new MemoryEventStore()
		: new FileEventStore(config.dataPath, platform.fs)

	const { llmProvider, llmProviders, llmLogger } = createLLMProvider(config, logger, platform)

	const presets = new Map(userConfig.presets.map(p => [p.id, p]))
	logger.info('Loaded presets', { count: presets.size })

	const toolExecutor = new ToolExecutorImpl(logger)
	const dataFileStore = new SessionFileStore(config.dataPath, undefined, false, platform.fs, 'session')
	const portPool = new PortPool()

	const preprocessorRegistry = new PreprocessorRegistry()
	preprocessorRegistry.register(new ImageClassifierPreprocessor({ llmProvider, logger, fs: platform.fs }))
	preprocessorRegistry.register(new MarkitdownPreprocessor({ registry: preprocessorRegistry, logger, fs: platform.fs, process: platform.process }))
	preprocessorRegistry.register(new ZipPreprocessor({ registry: preprocessorRegistry, logger, process: platform.process }))

	logger.info('Bootstrap complete')

	return {
		eventStore,
		llmProvider,
		llmProviders,
		llmLogger,
		toolExecutor,
		logger,
		presets,
		dataFileStore,
		config,
		portPool,
		preprocessorRegistry,
		platform,
	}
}

function createLogger(config: Config): Logger {
	return config.logFormat === 'json'
		? new JsonLogger(config.logLevel)
		: new ConsoleLogger({ level: config.logLevel })
}

function createLLMProvider(config: Config, logger: Logger, platform: Platform): {
	llmProvider: LLMProvider
	llmProviders: ReadonlyMap<string, LLMProvider>
	llmLogger?: LLMLogger
} {
	if (config.llmMock) {
		const mock = new MockLLMProvider(config.llmMock)
		return { llmProvider: mock, llmProviders: new Map([['mock', mock]]) }
	}

	const imageResizer = new VipsImageResizer({ fs: platform.fs, process: platform.process, tmpDir: platform.tmpDir })
	const imageProcessor = new DefaultImageProcessor(imageResizer, platform.fs)

	const routableProviders: RoutableLLMProvider[] = []
	let fallbackProvider: LLMProvider | undefined

	// Named provider registry for middleware useProvider()
	const namedProviders = new Map<string, LLMProvider>()

	// Register Anthropic provider if API key is set
	if (config.anthropicApiKey) {
		const anthropic = new AnthropicProvider({
			apiKey: config.anthropicApiKey,
			defaultModel: config.defaultModel,
			logger,
			imageProcessor,
			thinkingBudget: config.thinkingBudget,
		})
		routableProviders.push(anthropic)
		namedProviders.set('anthropic', anthropic)
		logger.info('Registered Anthropic provider')
	}

	// Register OpenRouter as fallback if API key is set
	if (config.openRouterApiKey) {
		fallbackProvider = new OpenRouterProvider({
			apiKey: config.openRouterApiKey,
			defaultModel: config.defaultModel,
			logger,
			imageProcessor,
		})
		namedProviders.set('openrouter', fallbackProvider)
		logger.info('Registered OpenRouter provider (fallback)')
	}

	// If only Anthropic is configured (no fallback), use it directly
	const baseProvider: LLMProvider = routableProviders.length > 0 || fallbackProvider
		? new RoutingLLMProvider(routableProviders, fallbackProvider)
		: routableProviders[0]

	logger.info('LLM routing configured', {
		providers: routableProviders.map((p) => p.name),
		fallback: fallbackProvider?.name ?? 'none',
		defaultModel: config.defaultModel,
	})

	if (config.llmLoggingEnabled === false) {
		return { llmProvider: baseProvider, llmProviders: namedProviders }
	}

	const llmLogger = new LLMLogger({ basePath: config.dataPath, enabled: true, fs: platform.fs })
	logger.info('LLM request logging enabled', { path: config.dataPath })

	return {
		llmProvider: new LoggingLLMProvider(baseProvider, llmLogger, logger),
		llmProviders: namedProviders,
		llmLogger,
	}
}

/**
 * Create a System wired to bootstrapped services.
 * Returns the full System object with SessionManager, typed method schemas, and lifecycle methods.
 */
export function createSystemFromServices(
	services: Services,
	options?: {
		onUserOutput?: UserOutputCallback
	},
): System<BuiltinMethodSchemas, typeof builtinPlugins> {
	return createSystem({
		plugins: builtinPlugins,
		eventStore: services.eventStore,
		llmProvider: services.llmProvider,
		llmProviders: services.llmProviders,
		toolExecutor: services.toolExecutor,
		presets: services.presets,
		logger: services.logger,
		basePath: services.config.dataPath,
		dataFileStore: services.dataFileStore,
		onUserOutput: options?.onUserOutput,
		preprocessorRegistry: services.preprocessorRegistry,
		llmLogger: services.llmLogger,
		portPool: services.portPool,
		platform: services.platform,
	})
}

/**
 * Create a SessionManager wired to bootstrapped services.
 * @deprecated Use createSystemFromServices() instead for typed method registry.
 */
export function createSessionManager(
	services: Services,
	options?: {
		onUserOutput?: UserOutputCallback
	},
): SessionManager {
	return createSystemFromServices(services, options).sessionManager
}

/**
 * Bootstrap for testing with memory store and mock LLM.
 *
 * @param mockHandler - Optional custom mock handler for LLM responses
 * @param presets - Optional presets array (defaults to empty)
 */
// Note: bootstrapForTesting lives in `src/testing/bootstrap-for-testing.ts`
// so production bootstrap has no dependency on the node test-platform helper.
