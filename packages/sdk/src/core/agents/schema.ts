/**
 * Agent domain types and schemas
 *
 * Contains all types related to agents:
 * - Branded ID type and constructor
 * - Agent status types (domain and protocol)
 * - Zod schemas for validation
 */

import z from 'zod/v4'

// ============================================================================
// AgentId - Branded type
// ============================================================================

/** AgentId schema - validates any string and brands as AgentId. */
export const agentIdSchema = z.string().brand('AgentId')

/** Branded AgentId type */
export type AgentId = z.infer<typeof agentIdSchema>

/** Constructor for AgentId */
export const AgentId = (id: string): AgentId => id as AgentId

/**
 * Generate a short agent ID based on definition name and sequence number.
 * Format: {definitionName}_{seq} e.g., "orchestrator_1", "planner_2"
 */
export const generateAgentId = (definitionName: string, seq: number): AgentId => AgentId(`${definitionName}_${seq}`)

// ============================================================================
// AgentId - Zod schemas
// ============================================================================

// ============================================================================
// AgentStatus - Domain type (internal state machine)
// ============================================================================

/**
 * Domain agent status - represents the internal state machine.
 * Used by the agent runtime and event sourcing.
 */
export type AgentStatus = 'pending' | 'inferring' | 'tool_exec' | 'errored' | 'paused'

/**
 * Zod schema for domain agent status.
 */
export const agentStatusSchema = z.enum(['pending', 'inferring', 'tool_exec', 'errored', 'paused'])

// ============================================================================
// AgentStatus - Protocol type (for UI/SPA)
// ============================================================================

/**
 * Protocol agent status - represents the UI-friendly status.
 * Maps from domain status for display in the SPA.
 */
export type ProtocolAgentStatus = 'idle' | 'thinking' | 'responding' | 'waiting_for_user' | 'error' | 'paused'

/**
 * Zod schema for protocol agent status.
 */
export const protocolAgentStatusSchema = z.enum(['idle', 'thinking', 'responding', 'waiting_for_user', 'error', 'paused'])

// ============================================================================
// Test helpers
// ============================================================================

let testCounter = 0

/**
 * Generate a test agent ID (for tests only).
 * Uses incrementing counter for uniqueness.
 */
export const generateTestAgentId = (definitionName = 'test-agent'): AgentId => AgentId(`${definitionName}_${++testCounter}`)
