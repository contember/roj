export interface SnapshotRefs {
	workspaceRef?: string
	sessionRef?: string
}

export interface ForkSnapshotOptions {
	sourceSessionDir: string
	sourceWorkspaceDir?: string
	sessionRef?: string
	workspaceRef?: string
}

export interface Snapshotter {
	/** Initialize snapshot repositories. Called once when session is created. */
	init(): Promise<void>
	/** Take a snapshot and return refs for current state. */
	snapshot(): Promise<SnapshotRefs>
	/** Initialize from a fork of another session's snapshot. */
	initFromFork?(options: ForkSnapshotOptions): Promise<void>
}
