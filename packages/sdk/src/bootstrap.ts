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
import { ImageClassifierPreprocessor, MarkitdownPreprocessor, PdfPreprocessor, ZipPreprocessor } from '~/plugins/uploads/preprocessors/index.js'
import type { Config } from './config.js'
import { SessionFileStore } from './core/file-store/file-store.js'
import type { SessionManager } from './core/sessions/session-manager.js'
import type { UserOutputCallback } from './core/sessions/session.js'
import { type AllMethodSchemas, createSystem, type System } from './core/system.js'
import type { ToolExecutor } from './core/tools/executor.js'
import { ToolExecutor as ToolExecutorImpl } from './core/tools/executor.js'
import { ConsoleLogger, JsonLogger } from './lib/logger/index.js'
import type { Logger } from './lib/logger/logger.js'
import { Semaphore } from './lib/utils/concurrency.js'
import { agentStatusPlugin } from './plugins/agent-status/plugin.js'
import { agentsPlugin } from './plugins/agents/plugin.js'
import { filesystemPlugin } from './plugins/filesystem/index.js'
import { gitStatusPlugin } from './plugins/git-status/index.js'
import { llmDebugPlugin } from './plugins/llm-debug/plugin.js'
import { logsPlugin } from './plugins/logs/index.js'
import { mailboxPlugin } from './plugins/mailbox/plugin.js'
import { servicePlugin } from './plugins/services/plugin.js'
import { ServicePidRegistry } from './plugins/services/pid-registry.js'
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
 * Registered in every session under the default `full` profile (see
 * SessionManager.createSessionInstance).
 *
 * This set is also the RPC contract: `BuiltinMethodSchemas` — and through it
 * every client's method types — derives from it whichever profile a host registers.
 */
export const fullPlugins = [
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

/**
 * Built-in plugins that run without an OS process table, for hosts like a Worker
 * isolate. Drops `uploads`, `resources` and `services` — each of them shells out
 * (pdftotext/markitdown, unzip, dev servers).
 *
 * `git-status` stays: it reads `platform.git` where the host offers one, and
 * stops polling where it does not.
 *
 * `satisfies` keeps this a strict subset of `fullPlugins`, so it cannot name a
 * plugin the RPC contract does not know about.
 */
export const isolatePlugins = [
	sessionLifecyclePlugin,
	presetsPlugin,
	mailboxPlugin,
	agentsPlugin,
	agentStatusPlugin,
	userChatPlugin,
	llmDebugPlugin,
	filesystemPlugin,
	logsPlugin,
	sessionStatsPlugin,
	sessionStatePlugin,
	gitStatusPlugin,
] as const satisfies readonly (typeof fullPlugins)[number][]

/** Which built-in plugin set a host registers. */
export type PluginProfile = 'full' | 'isolate'

/** Method schemas inferred from all built-in plugins */
export type BuiltinMethodSchemas = AllMethodSchemas<typeof fullPlugins>

/** Method schemas the `isolate` profile actually registers */
export type IsolateMethodSchemas = AllMethodSchemas<typeof isolatePlugins>

/** Options for {@link bootstrap}. */
export interface BootstrapOptions<TProfile extends PluginProfile = PluginProfile> {
	/** Built-in plugin set to register. Defaults to `full`. */
	pluginProfile: TProfile
}

/**
 * Container for all bootstrapped services
 */
export interface Services<TProfile extends PluginProfile = 'full'> {
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
	/** Durable record of spawned service processes, swept once at boot. */
	pidRegistry: ServicePidRegistry
	/** Preprocessor registry for upload content extraction */
	preprocessorRegistry: PreprocessorRegistry
	/** Host-environment adapters (filesystem, process). */
	platform: Platform
	/** Built-in plugin set chosen at bootstrap — selects what createSystemFromServices registers. */
	pluginProfile: TProfile
}

/**
 * Bootstrap all services based on configuration.
 *
 * `platform` provides runtime adapters (fs, process, scheduler). Callers pass concrete
 * impls from their runtime package (e.g. `createBunPlatform()` from
 * `@roj-ai/sdk/bun-platform`).
 *
 * `options.pluginProfile` picks the built-in plugin set; it defaults to `full`.
 */
export function bootstrap<TProfile extends PluginProfile>(
	config: Config,
	userConfig: RojConfig,
	platform: Platform,
	options: BootstrapOptions<TProfile>,
): Services<TProfile>
export function bootstrap(config: Config, userConfig: RojConfig, platform: Platform): Services
export function bootstrap(config: Config, userConfig: RojConfig, platform: Platform, options?: BootstrapOptions): Services<PluginProfile> {
	const pluginProfile = options?.pluginProfile ?? 'full'
	const logger = createLogger(config)
	logger.info('Bootstrapping agent server', { persistence: config.persistence, logLevel: config.logLevel, pluginProfile })

	const eventStore = config.persistence === 'memory'
		? new MemoryEventStore()
		: new FileEventStore(config.dataPath, platform.fs, logger)

	const { llmProvider, llmProviders, llmLogger } = createLLMProvider(config, logger, platform)

	const presets = new Map(userConfig.presets.map(p => [p.id, p]))
	logger.info('Loaded presets', { count: presets.size })

	const toolExecutor = new ToolExecutorImpl(logger)
	const dataFileStore = new SessionFileStore(config.dataPath, undefined, false, platform.fs, 'session')
	const portPool = new PortPool()
	// Swept by the server before it serves — see ServicePidRegistry.sweepOrphans.
	const pidRegistry = new ServicePidRegistry(platform.fs, logger, config.dataPath)

	const preprocessorRegistry = new PreprocessorRegistry()
	const imageClassifierGate = new Semaphore(config.imageClassifierConcurrency ?? 10)
	// Dedicated resizer for the classification path: separate from the LLM
	// provider's general-purpose ImageProcessor (which keeps a higher
	// maxDimension for agent file-inspection tool calls). The classifier
	// hands each image to the resizer with its own 1024px override.
	const classifierImageResizer = new VipsImageResizer({ fs: platform.fs, process: platform.process, tmpDir: platform.tmpDir })
	preprocessorRegistry.register(new ImageClassifierPreprocessor({ llmProvider, logger, fs: platform.fs, gate: imageClassifierGate, imageResizer: classifierImageResizer }))
	// PdfPreprocessor must come before MarkitdownPreprocessor — both could
	// match `application/pdf` in principle, but the registry uses first-hit
	// and PdfPreprocessor's `pdftotext + pdfimages -all + streaming` pipeline
	// is dramatically faster than markitdown's pdfminer.six backend.
	preprocessorRegistry.register(new PdfPreprocessor({ registry: preprocessorRegistry, logger, fs: platform.fs, process: platform.process }))
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
		pidRegistry,
		preprocessorRegistry,
		platform,
		pluginProfile,
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

interface CreateSystemFromServicesOptions {
	onUserOutput?: UserOutputCallback
}

/** Everything a System needs except the plugin set, which the profile picks. */
function buildSystem(services: Services<PluginProfile>, options?: CreateSystemFromServicesOptions) {
	const wiring = {
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
		uploadArchiveLimits: services.config.uploadArchiveLimits,
		resourceArchiveLimits: services.config.resourceArchiveLimits,
		llmLogger: services.llmLogger,
		portPool: services.portPool,
		pidRegistry: services.pidRegistry,
		platform: services.platform,
		sessionIdleTimeoutMs: services.config.sessionIdleTimeoutMs,
	}

	return services.pluginProfile === 'isolate'
		? createSystem({ ...wiring, plugins: isolatePlugins })
		: createSystem({ ...wiring, plugins: fullPlugins })
}

/**
 * Create a System wired to bootstrapped services.
 * Returns the full System object with SessionManager, typed method schemas, and lifecycle methods.
 *
 * Which plugins get registered follows the profile `services` was bootstrapped
 * with. `BuiltinMethodSchemas` still covers every built-in plugin, so a client
 * may name a method the running profile does not register — that call comes back
 * as a method-not-found error, the same as any unknown method.
 */
export function createSystemFromServices(
	services: Services<'isolate'>,
	options?: CreateSystemFromServicesOptions,
): System<IsolateMethodSchemas, typeof isolatePlugins>
export function createSystemFromServices(
	services: Services,
	options?: CreateSystemFromServicesOptions,
): System<BuiltinMethodSchemas, typeof fullPlugins>
export function createSystemFromServices(services: Services<PluginProfile>, options?: CreateSystemFromServicesOptions) {
	return buildSystem(services, options)
}

/**
 * Create a SessionManager wired to bootstrapped services.
 * @deprecated Use createSystemFromServices() instead for typed method registry.
 */
export function createSessionManager(
	services: Services<PluginProfile>,
	options?: CreateSystemFromServicesOptions,
): SessionManager {
	return buildSystem(services, options).sessionManager
}

/**
 * Bootstrap for testing with memory store and mock LLM.
 *
 * @param mockHandler - Optional custom mock handler for LLM responses
 * @param presets - Optional presets array (defaults to empty)
 */
// Note: bootstrapForTesting lives in `src/testing/bootstrap-for-testing.ts`
// so production bootstrap has no dependency on the node test-platform helper.
