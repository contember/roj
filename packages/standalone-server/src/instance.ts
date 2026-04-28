/**
 * Singleton instance state for the standalone server.
 *
 * A standalone server hosts exactly one "instance" — a workspace containing
 * sessions. The instance id is either supplied via config or auto-generated
 * on startup and remains stable for the process lifetime.
 */

export interface InstanceState {
	id: string
	name: string
	createdAt: string
	presetIds: string[]
}

export function createInstance(options: { id?: string; name?: string; presetIds: string[] }): InstanceState {
	return {
		id: options.id ?? 'default',
		name: options.name ?? 'standalone',
		createdAt: new Date().toISOString(),
		presetIds: options.presetIds,
	}
}
