/**
 * Roj Agent Server
 *
 * WebSocket bridge server connecting agent framework with worker/SPA
 */

// Config
export { loadConfig, validateConfig } from './config.js'
export type { Config } from './config.js'

// Bootstrap
export { bootstrap, createSystemFromServices } from './bootstrap.js'
export type { Services } from './bootstrap.js'

// System
export { createSystem } from './core/system.js'
export type { CreateSystemOptions, System } from './core/system.js'

// Lib exports
export { FileEventStore, MemoryEventStore } from '~/core/events/index.js'
export { MockLLMProvider, OpenRouterProvider, RequestMatchers } from '~/core/llm/index.js'
export type { MockInferenceHandler, OpenRouterConfig } from '~/core/llm/index.js'
export { ConsoleLogger, JsonLogger } from '~/lib/logger/index.js'
export type { ConsoleLoggerConfig } from '~/lib/logger/index.js'
export type { LogLevel, Logger } from '~/lib/logger/logger.js'

// User config
export { defineConfig } from './user-config.js'
export type { RojConfig } from './user-config.js'

// Transport adapters
export { ClientAdapter, createAgentTransport, ServerAdapter } from './transport/adapter/index.js'
export type { AgentTransportConfig, IAgentTransport, PluginNotification } from './transport/adapter/index.js'

// Runtime
export { Agent } from '~/core/agents/agent.js'
export type { AgentConfig } from '~/core/agents/agent.js'
export { SessionManager } from '~/core/sessions/session-manager.js'
export type { SessionManagerOptions } from '~/core/sessions/session-manager.js'
export { SessionStore } from '~/core/sessions/session-store.js'
export { Session } from '~/core/sessions/session.js'
export type { UserOutputCallback } from '~/core/sessions/session.js'

// Preset builder (for defining agent presets)
export { createOrchestrator, createPreset, defineAgent, validatePreset } from '~/core/preset/index.js'
export type { Preset } from '~/core/preset/index.js'

// Domain types (re-exported for external consumers, replacing @roj-ai/shared root exports)
export { AgentId } from '~/core/agents/schema.js'
export type { AgentStatus as DomainAgentStatus, ProtocolAgentStatus, ProtocolAgentStatus as AgentStatus } from '~/core/agents/schema.js'
export { agentEvents } from '~/core/agents/state.js'
export type { AgentPauseReason, AgentState, LLMMessage } from '~/core/agents/state.js'
export type { DomainEvent } from '~/core/events/types.js'
export type { FactoryEventType } from '~/core/events/types.js'
export { isDomainEvent } from '~/core/events/types.js'
export type { ChatMessageContentItem, LLMCallLogEntry, LLMCallMessage, ToolResultContent } from '~/core/llm/llm-log-types.js'
export { contentToString } from '~/core/llm/llm-log-types.js'
export { applyMiddleware, useProvider, withAnthropic, withMaxTokens, withOpenRouter, withTemperature } from '~/core/llm/middleware.js'
export type { InferenceNext, LLMMiddleware } from '~/core/llm/middleware.js'
export { ModelId } from '~/core/llm/schema.js'
export type { LLMCallId } from '~/core/llm/schema.js'
export type { InferenceCompletedEvent, InferenceFailedEvent, InferenceStartedEvent } from '~/core/llm/state.js'
export { estimateTokens } from '~/core/llm/tokens.js'
export { applyEvent } from '~/core/sessions/apply-event.js'
export { selectPluginState } from '~/core/sessions/reducer.js'
export { SessionId } from '~/core/sessions/schema.js'
export type { SessionMetadata } from '~/core/sessions/schema.js'
export { createSessionState, reconstructSessionState } from '~/core/sessions/state.js'
export type { SessionState } from '~/core/sessions/state.js'
export type { ToolCallId } from '~/core/tools/schema.js'
export type { ToolStartedEvent } from '~/core/tools/state.js'
export { getAgentMailbox, selectMailboxState } from '~/plugins/mailbox/query.js'
export type { MailboxPluginState } from '~/plugins/mailbox/query.js'
export { MessageId } from '~/plugins/mailbox/schema.js'
export type { MailboxMessage } from '~/plugins/mailbox/schema.js'
export type { ServiceStatus } from '~/plugins/services/schema.js'
export { ChatMessageId } from '~/plugins/user-chat/schema.js'
export type { AskUserInputType, AskUserInputTypeSchema, AskUserOption } from '~/plugins/user-chat/schema.js'
export type { BuiltinEvent } from './builtin-events.js'

// Chat message types (re-exported for external consumers)
export type { AgentChatMessage, AskUserChatMessage, ChatMessage, UserChatMessage } from '~/plugins/user-chat/index.js'

// Plugins
export { agentStatusPlugin } from '~/plugins/agent-status/plugin.js'
export { agentsPlugin } from '~/plugins/agents/plugin.js'
export type { AgentsPluginConfig } from '~/plugins/agents/plugin.js'
export { contextCompactPlugin } from '~/plugins/context-compact/plugin.js'
export type { ContextCompactPluginConfig } from '~/plugins/context-compact/plugin.js'
export { limitsGuardPlugin, selectAgentCounters } from '~/plugins/limits-guard/plugin.js'
export type { AgentCounters, LimitsAgentConfig } from '~/plugins/limits-guard/plugin.js'
export type { AgentLimits } from '~/plugins/limits-guard/config.js'
export { mailboxPlugin } from '~/plugins/mailbox/plugin.js'
export type { MailboxAgentConfig, MailboxPresetConfig } from '~/plugins/mailbox/plugin.js'
export { resultEvictionPlugin } from '~/plugins/result-eviction/plugin.js'
export type { EvictionAgentConfig, EvictionConfig } from '~/plugins/result-eviction/plugin.js'
export { servicePlugin } from '~/plugins/services/plugin.js'
export type { ServiceAgentConfig, ServiceStatusChangedEvent } from '~/plugins/services/plugin.js'
export { sessionStatePlugin } from '~/plugins/session-state/plugin.js'
export type { SessionStatePluginConfig } from '~/plugins/session-state/plugin.js'
export { presetsPlugin, sessionLifecyclePlugin } from '~/plugins/session-lifecycle/plugin.js'
export { selectAgentSkills, skillsPlugin } from '~/plugins/skills/plugin.js'
export type { SkillsAgentConfig, SkillsPluginConfig } from '~/plugins/skills/plugin.js'
export type { SkillLoadedEvent } from '~/plugins/skills/plugin.js'
export type { LoadedSkill } from '~/plugins/skills/schema.js'
export { todoPlugin } from '~/plugins/todo/plugin.js'
export type { TodoAgentConfig, TodoPresetConfig } from '~/plugins/todo/plugin.js'
export { resourcesPlugin } from '~/plugins/resources/plugin.js'
export type { ResourcesPluginConfig } from '~/plugins/resources/plugin.js'
export { postInjectRules } from '~/plugins/resources/post-inject.js'
export type {
	PostInjectContext,
	PostInjectExecOptions,
	PostInjectHook,
	PostInjectRule,
} from '~/plugins/resources/post-inject.js'
export { RESOURCE_MANIFEST_FILENAME, ResourceManifestSchema } from '~/plugins/resources/manifest.js'
export type { ResourceManifest } from '~/plugins/resources/manifest.js'
export { uploadsPlugin } from '~/plugins/uploads/plugin.js'
export { userChatPlugin } from '~/plugins/user-chat/plugin.js'
export type { UserChatAgentConfig, UserChatPresetConfig, UserCommunicationMode } from '~/plugins/user-chat/plugin.js'

// Workers plugin
export { workerPlugin } from '~/plugins/workers/index.js'
export type { WorkerAgentConfig, WorkerPresetConfig } from '~/plugins/workers/index.js'
export type { WorkerDefinition } from '~/plugins/workers/index.js'
export { createWorkerDefinition } from '~/plugins/workers/index.js'
export type { WorkerContext } from '~/plugins/workers/index.js'
export type { WorkerError, WorkerResult } from '~/plugins/workers/index.js'

// Plugin builder
export { definePlugin } from '~/core/plugins/plugin-builder.js'
export type { CallerContext, ConfiguredPlugin, PluginDefinition } from '~/core/plugins/plugin-builder.js'

// Zod (re-export for presets that need schemas)
export { default as z } from 'zod/v4'

// Result utilities
export { Err, Ok } from '~/lib/utils/result.js'
export type { Result } from '~/lib/utils/result.js'

// File store
export type { FileEntry, FileStore } from '~/core/file-store/types.js'

// Service config
export { PortPool } from '~/plugins/services/port-pool.js'
export type { ServiceCommandArgs, ServiceConfig } from '~/plugins/services/schema.js'

// Session environment
export type { SessionEnvironment } from '~/core/sessions/session-environment.js'

// Platform adapters (host-environment abstractions — filesystem, process)
// Interfaces only; concrete impls (createBunPlatform) live in @roj-ai/sdk/bun-platform.
export type {
	ChildProcess,
	Dirent,
	ExecFileOptions,
	ExecFileResult,
	FileHandle,
	FileSystem,
	Platform,
	ProcessRunner,
	SpawnOptions,
	Stats,
} from '~/platform/index.js'
