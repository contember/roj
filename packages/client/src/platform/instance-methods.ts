/**
 * Instance-scoped RPC method definitions.
 *
 * These methods are called from the SPA via POST /api/v1/instances/:id/rpc
 * with instance token or cookie auth. The instance is already resolved by the route,
 * so inputs do NOT contain instanceId.
 *
 * Shared between worker (server) and client SDK.
 */
import { defineMethods, method } from './rpc-definition'
import type { PublishSessionOutput, GetAgentLogsOutput } from './methods'

// ============================================================================
// Sandbox methods
// ============================================================================

export type InstanceCreateSandboxInput = {}
export interface InstanceCreateSandboxOutput {
	sandboxId: string
}

export interface InstancePauseSandboxInput {
	sandboxId: string
}

export type InstanceResumeSandboxInput = {}

export interface InstanceTerminateSandboxInput {
	sandboxId: string
}

export interface InstanceRestartAgentInput {
	sandboxId: string
}

export interface InstanceGetAgentLogsInput {
	sandboxId: string
	lines?: number
}

export interface InstanceExecInSandboxInput {
	command: string
}

export interface InstanceExecInSandboxOutput {
	stdout: string
	stderr: string
	success: boolean
}

export interface InstanceValidateSandboxTokenInput {
	sandboxId: string
	token: string
}

export interface InstanceValidateSandboxTokenOutput {
	value: boolean
}

// ============================================================================
// Session methods
// ============================================================================

export interface InstanceCreateSessionInput {
	presetId: string
}

export interface InstanceCreateSessionOutput {
	sessionId: string
}

export type InstanceListSessionsInput = {}
export interface InstanceListSessionsOutput {
	sessions: Array<{
		id: string
		presetId: string | null
		status: string
		createdAt: number
	}>
}

export interface InstancePublishSessionInput {
	sessionId: string
}

// ============================================================================
// Service methods
// ============================================================================

export interface InstanceGetServiceUrlInput {
	sessionId: string
	serviceType: string
}

export interface InstanceGetServiceUrlOutput {
	url: string | null
}

export interface InstanceGetServiceUrlsInput {
	sessionId: string
}

export interface InstanceGetServiceUrlsOutput {
	services: Array<{
		serviceType: string
		code: string
		port: number
	}>
}

export interface InstanceEnsureSandboxOutput {
	sandboxId: string
	state: string
}

// ============================================================================
// Shared output for void actions
// ============================================================================

export interface InstanceOkOutput {
	ok: boolean
}

// ============================================================================
// Method registry
// ============================================================================

export const instanceMethods = defineMethods({
	// Sandbox
	createSandbox: method<InstanceCreateSandboxInput, InstanceCreateSandboxOutput>(),
	pauseSandbox: method<InstancePauseSandboxInput, InstanceOkOutput>(),
	resumeSandbox: method<InstanceResumeSandboxInput, InstanceOkOutput>(),
	terminateSandbox: method<InstanceTerminateSandboxInput, InstanceOkOutput>(),
	restartAgent: method<InstanceRestartAgentInput, InstanceOkOutput>(),
	getAgentLogs: method<InstanceGetAgentLogsInput, GetAgentLogsOutput>(),
	execInSandbox: method<InstanceExecInSandboxInput, InstanceExecInSandboxOutput>(),
	validateSandboxToken: method<InstanceValidateSandboxTokenInput, InstanceValidateSandboxTokenOutput>(),

	// Sessions
	createSession: method<InstanceCreateSessionInput, InstanceCreateSessionOutput>(),
	listSessions: method<InstanceListSessionsInput, InstanceListSessionsOutput>(),
	publishSession: method<InstancePublishSessionInput, PublishSessionOutput>(),

	// Services
	getServiceUrl: method<InstanceGetServiceUrlInput, InstanceGetServiceUrlOutput>(),
	getServiceUrls: method<InstanceGetServiceUrlsInput, InstanceGetServiceUrlsOutput>(),

	// Idempotent sandbox access
	ensureSandbox: method<{}, InstanceEnsureSandboxOutput>(),
})

export type InstanceMethods = typeof instanceMethods
export type InstanceMethodName = keyof InstanceMethods
