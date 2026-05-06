/**
 * Singleton instance state for the standalone server.
 *
 * A standalone server hosts exactly one "instance" — a workspace containing
 * sessions. The instance id is either supplied via config or auto-generated
 * on startup and remains stable for the process lifetime.
 *
 * `metadata` is mutated by `instances.create` calls (last write wins). It is
 * a single-tenant local-dev convenience; consumers that need per-instance
 * isolation must run separate processes.
 */

export interface InstanceState {
	id: string
	name: string
	createdAt: string
	presetIds: string[]
	metadata: Record<string, unknown> | null
}

export function createInstance(options: {
	id?: string
	name?: string
	presetIds: string[]
	metadata?: Record<string, unknown> | null
}): InstanceState {
	return {
		id: options.id ?? 'default',
		name: options.name ?? 'standalone',
		createdAt: new Date().toISOString(),
		presetIds: options.presetIds,
		metadata: options.metadata ?? null,
	}
}
