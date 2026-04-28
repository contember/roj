/**
 * Session environment directories.
 * Shared between agent-server tools and handler contexts.
 */
export interface SessionEnvironment {
	/** Absolute path to the session directory */
	sessionDir: string
	/** Absolute path to the workspace directory (optional) */
	workspaceDir?: string
	/** When true, agents see virtual paths instead of real filesystem paths */
	sandboxed: boolean
}
