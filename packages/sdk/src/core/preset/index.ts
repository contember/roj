/**
 * Preset module - type-safe preset builder and configuration
 */

// Re-export from config
export type { PresetDefinition as Preset } from './config.js'
export { createPreset, validatePreset } from './config.js'

// Re-export from preset-builder
export type { CreateOrchestratorInput, DefineAgentInput } from './preset-builder.js'
export { createOrchestrator, defineAgent } from './preset-builder.js'
