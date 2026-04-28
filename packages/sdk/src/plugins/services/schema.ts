/**
 * Service domain types
 *
 * Services are session-scoped background processes (e.g., dev servers)
 * that agents can observe and control. Unlike workers, services are
 * long-running, one instance per type, and shared across agents.
 */

// ============================================================================
// Service Status
// ============================================================================

/**
 * Service lifecycle status.
 */
export type ServiceStatus = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed' | 'paused'

// ============================================================================
// Service Config (declared in presets)
// ============================================================================

/**
 * Arguments passed to command callback for dynamic command construction.
 */
export interface ServiceCommandArgs {
	port: number
}

/**
 * Service configuration declared inline in presets.
 * Defines how to spawn and monitor a background process.
 */
export interface ServiceConfig {
	/** Unique service type within preset, e.g. 'astro-dev' */
	type: string
	/** Human-readable description */
	description: string
	/** Shell command to run, or a callback receiving allocated port */
	command: string | ((args: ServiceCommandArgs) => string)
	/** Working directory (defaults to workspace dir) */
	cwd?: string
	/** Additional environment variables */
	env?: Record<string, string>
	/** Start automatically with session (default: false) */
	autoStart?: boolean
	/** Regex pattern to detect "ready" in stdout */
	readyPattern?: string
	/** SIGTERM→SIGKILL timeout in ms (default: 5000) */
	gracefulStopMs?: number
	/** Ring buffer size for log lines (default: 200) */
	logBufferSize?: number
	/** Startup timeout in ms — service marked as failed if not ready within this time (default: 30000) */
	startupTimeoutMs?: number
	/** Auto-pause configuration (interface prepared, not yet implemented) */
	autoPause?: { inactivityMs: number }
}

// ============================================================================
// Service Entry (in SessionState)
// ============================================================================

/**
 * Service entry tracked in session state.
 * Updated via service_status_changed events.
 */
export interface ServiceEntry {
	serviceType: string
	status: ServiceStatus
	port?: number
	error?: string
	startedAt?: number
	readyAt?: number
	stoppedAt?: number
	/** Process group PID (tracked for orphan cleanup after restart) */
	pid?: number
	/**
	 * Process start time in clock ticks since boot, read from /proc/<pid>/stat field 22.
	 * Used to detect PID reuse during orphan reconcile: before SIGKILL, we re-read the
	 * current start time and compare — mismatch means the PID was recycled by an
	 * unrelated process and must NOT be killed. Linux-only; undefined on macOS/Windows.
	 */
	pidStartTime?: number
}
