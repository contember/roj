/**
 * Platform RPC method definitions.
 *
 * Single source of truth for all platform API method types.
 * Shared between worker (server) and client SDK.
 */
import { defineMethods, method } from './rpc-definition'
import type { SandboxState } from './sandbox-state'

// ============================================================================
// Instance methods
// ============================================================================

export interface CreateInstanceInput {
	templateSlug: string
	bundleSlug?: string
	bundleRevisionId?: string
	name: string
	vcsType?: 'github' | 'gitLocal' | 'none'
	metadata?: Record<string, unknown>
	autoCreateSession?: {
		presetId: string
		blocking?: boolean
		initialPrompt?: string
		resourceIds?: string[]
		fileIds?: string[]
	}
}

export interface CreateInstanceOutput {
	instanceId: string
	status: 'created' | 'initializing' | 'ready'
	sessionId?: string
	wsToken?: string
}

export interface GetInstanceInput {
	instanceId: string
}

export interface GetInstanceOutput {
	instanceId: string
	name: string
	status: string
	templateSlug: string
	bundleSlug: string
	bundleRevisionId: string
	vcsType: string
	metadata: Record<string, unknown> | null
	createdAt: string
}

export interface GetInstanceStatusInput {
	instanceId: string
}

export interface GetInstanceStatusOutput {
	instanceId: string
	status: string
	sandbox: {
		state: SandboxState
		e2bId?: string
		lastActivityAt?: string
	} | null
	sessions: Array<{
		id: string
		presetId: string | null
		status: string
		createdAt: string
	}>
	lifecycleEvents: Array<{
		event: string
		detail?: string
		createdAt: string
	}>
	serviceUrls: Array<{
		code: string
		sessionId: string | null
		serviceType: string | null
		port: number
	}>
}

export interface ArchiveInstanceInput {
	instanceId: string
}

export interface ArchiveInstanceOutput {
	ok: boolean
}

export interface ListInstancesInput {
	limit?: number
	offset?: number
}

export interface ListInstancesOutput {
	instances: GetInstanceOutput[]
	total: number
}

// ============================================================================
// Session methods
// ============================================================================

export interface CreateSessionInput {
	instanceId: string
	presetId: string
	blocking?: boolean
	origin?: string
	expiresIn?: number // token TTL in seconds (default 24h, max 7d)
}

export interface CreateSessionOutput {
	sessionId: string
	status: 'creating' | 'active'
	wsToken?: string
}

export interface ListSessionsInput {
	instanceId: string
}

export interface ListSessionsOutput {
	sessions: Array<{
		id: string
		presetId: string | null
		status: string
		createdAt: string
	}>
}

export interface PublishSessionInput {
	instanceId: string
	sessionId: string
}

export interface PublishSessionOutput {
	ok: boolean
	pushed: boolean
	commitSha?: string
	error?: string
}

// ============================================================================
// Token methods
// ============================================================================

export interface CreateInstanceTokenInput {
	instanceId: string
	origin?: string
	expiresIn?: number // token TTL in seconds (default 24h, max 7d)
	meta?: Record<string, unknown> // custom claims propagated to plugin method caller context
}

export interface CreateInstanceTokenOutput {
	token: string
	expiresAt: string
}

// ============================================================================
// Bundle methods
// ============================================================================

export interface ListBundlesInput {
	limit?: number
	offset?: number
}

export interface ListBundlesOutput {
	bundles: Array<{
		id: string
		slug: string
		name: string | null
		description: string | null
		latestRevision: { id: string; version: string | null; r2Key: string; createdAt: string } | null
		createdAt: string
	}>
}

export interface DeleteBundleInput {
	bundleId?: string
	bundleSlug?: string
}

export interface DeleteBundleOutput {
	ok: boolean
}

// ============================================================================
// Resource methods
// ============================================================================

export interface CreateResourceInput {
	slug: string
	name?: string
	description?: string
	fileId: string
	label?: string
}

export interface CreateResourceOutput {
	resourceId: string
	revisionId: string
}

export interface AddResourceRevisionInput {
	resourceId?: string
	resourceSlug?: string
	fileId: string
	label?: string
}

export interface AddResourceRevisionOutput {
	revisionId: string
}

export interface GetResourceInput {
	resourceId?: string
	resourceSlug?: string
}

export interface GetResourceOutput {
	id: string
	slug: string
	name: string | null
	description: string | null
	latestRevision: {
		id: string
		label: string | null
		file: { id: string; filename: string; mimeType: string; size: number }
		createdAt: string
	} | null
	createdAt: string
}

export interface ListResourcesInput {
	limit?: number
	offset?: number
}

export interface ListResourcesOutput {
	resources: GetResourceOutput[]
}

export interface DeleteResourceInput {
	resourceId: string
}

export interface DeleteResourceOutput {
	ok: boolean
}

// ============================================================================
// Sandbox methods (admin/debug)
// ============================================================================

export interface PauseSandboxInput {
	instanceId: string
	sandboxId: string
}

export interface ResumeSandboxInput {
	instanceId: string
	sandboxId: string
}

export interface TerminateSandboxInput {
	instanceId: string
	sandboxId: string
}

export interface RestartAgentInput {
	instanceId: string
	sandboxId: string
}

export interface GetAgentLogsInput {
	instanceId: string
	sandboxId: string
	lines?: number
}

export interface GetAgentLogsOutput {
	logs: string
	truncated: boolean
}

export interface SandboxActionOutput {
	ok: boolean
}

// ============================================================================
// Services
// ============================================================================

export interface GetServiceUrlInput {
	instanceId: string
	sessionId: string
	serviceType: string
}

export interface GetServiceUrlOutput {
	url: string | null
}

// ============================================================================
// Method registry
// ============================================================================

export const platformMethods = defineMethods({
	// Instances
	'instances.create': method<CreateInstanceInput, CreateInstanceOutput>(),
	'instances.get': method<GetInstanceInput, GetInstanceOutput>(),
	'instances.list': method<ListInstancesInput, ListInstancesOutput>(),
	'instances.status': method<GetInstanceStatusInput, GetInstanceStatusOutput>(),
	'instances.archive': method<ArchiveInstanceInput, ArchiveInstanceOutput>(),

	// Sessions
	'sessions.create': method<CreateSessionInput, CreateSessionOutput>(),
	'sessions.list': method<ListSessionsInput, ListSessionsOutput>(),
	'sessions.publish': method<PublishSessionInput, PublishSessionOutput>(),

	// Tokens
	'tokens.create': method<CreateInstanceTokenInput, CreateInstanceTokenOutput>(),

	// Services
	'services.getUrl': method<GetServiceUrlInput, GetServiceUrlOutput>(),

	// Bundles
	'bundles.list': method<ListBundlesInput, ListBundlesOutput>(),
	'bundles.delete': method<DeleteBundleInput, DeleteBundleOutput>(),

	// Resources
	'resources.create': method<CreateResourceInput, CreateResourceOutput>(),
	'resources.addRevision': method<AddResourceRevisionInput, AddResourceRevisionOutput>(),
	'resources.get': method<GetResourceInput, GetResourceOutput>(),
	'resources.list': method<ListResourcesInput, ListResourcesOutput>(),
	'resources.delete': method<DeleteResourceInput, DeleteResourceOutput>(),
})

export type PlatformMethods = typeof platformMethods
export type PlatformMethodName = keyof PlatformMethods
