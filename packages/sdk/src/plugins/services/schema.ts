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
	/** Session id of the service owner. */
	sessionId: string
	/** Absolute path of the session workspace directory, when configured. */
	workspaceDir?: string
	/** Resolved working directory that will be passed to the child process. */
	cwd?: string
}

/**
 * Arguments passed to a `cwd` resolver callback. Resolved lazily at service
 * start, so the callback can inspect the (by-then-populated) workspace — e.g.
 * to locate the web app inside a monorepo before launching the dev server.
 */
export interface ServiceCwdArgs {
	/** Session id of the service owner. */
	sessionId: string
	/** Absolute path of the session workspace directory. */
	workspaceDir: string
}

/**
 * Arguments passed to service environment and readiness callbacks.
 */
export interface ServiceStartArgs extends ServiceCommandArgs {
	/** Recently captured service output lines. Empty before the process writes. */
	logs: readonly string[]
}

/**
 * Arguments passed to `availableWhen` before a service is started.
 */
export interface ServiceAvailabilityArgs {
	/** Session id of the service owner. */
	sessionId: string
	/** Absolute path of the session workspace directory, when configured. */
	workspaceDir?: string
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
	/** Shell command to run, or a callback receiving runtime start context */
	command: string | ((args: ServiceCommandArgs) => string | Promise<string>)
	/**
	 * Working directory (defaults to the workspace dir).
	 *
	 * A string is resolved relative to the workspace dir (absolute paths are
	 * used as-is). A callback is invoked at service start with the workspace
	 * dir, so the directory can be detected lazily once the workspace is
	 * populated (e.g. the web package inside a monorepo); its return value is
	 * resolved the same way.
	 */
	cwd?: string | ((args: ServiceCwdArgs) => string | Promise<string>)
	/** Additional environment variables, resolved after cwd and before spawn */
	env?: Record<string, string> | ((args: ServiceCommandArgs) => Record<string, string> | Promise<Record<string, string>>)
	/** Return false to make start/autoStart skip this service for the current workspace. */
	availableWhen?: (args: ServiceAvailabilityArgs) => boolean | Promise<boolean>
	/** Start automatically with session (default: false) */
	autoStart?: boolean
	/** Regex pattern to detect "ready" in stdout */
	readyPattern?: string
	/** Callback polled until it reports that the service is ready. */
	readyWhen?: (args: ServiceStartArgs) => boolean | Promise<boolean>
	/** Poll interval for readyWhen in ms (default: 250) */
	readyCheckIntervalMs?: number
	/** SIGTERM→SIGKILL timeout in ms (default: 5000) */
	gracefulStopMs?: number
	/** Ring buffer size for log lines (default: 200) */
	logBufferSize?: number
	/** Startup timeout in ms — service marked as failed if not ready within this time (default: 30000) */
	startupTimeoutMs?: number
	/**
	 * Bring the service back after an unexpected exit, on the port it already
	 * holds. Omitted means what has always happened: the service is left
	 * `failed` and waits for someone to call restart.
	 *
	 * For a long-running service nobody is watching — a dev server behind a
	 * preview URL — a crash otherwise means the URL stays dead until a human
	 * or an agent notices. The retry budget is per consecutive failure and
	 * resets once the service has stayed up for `healthyAfterMs`, so a process
	 * that dies repeatedly at startup still ends up `failed` instead of
	 * looping forever.
	 */
	restartPolicy?: {
		/** Consecutive automatic restarts before giving up (default: 3) */
		maxRetries?: number
		/** Delay before the first retry; doubles per attempt (default: 1000) */
		initialDelayMs?: number
		/** Ceiling for the doubling (default: 30000) */
		maxDelayMs?: number
		/** Uptime that counts as healthy and resets the budget (default: 60000) */
		healthyAfterMs?: number
	}
	/** Auto-pause configuration (interface prepared, not yet implemented) */
	autoPause?: { inactivityMs: number }
	/**
	 * When false, the service is hidden from the owning agent: excluded from its
	 * service_* tools and the session-context status block. It still runs at the
	 * session level and stays fully controllable via the services.* methods —
	 * for infrastructure services (e.g. a CMS sidecar) driven by the platform,
	 * not by agents. Default: true.
	 */
	agentVisible?: boolean
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
	/** Resolved working directory used for the current/last start. */
	cwd?: string
	/** Resolved command used for the current/last start. */
	command?: string
	startedAt?: number
	readyAt?: number
	stoppedAt?: number
	/**
	 * When a `restartPolicy` revival is queued, the epoch ms at which it fires.
	 * Present only while the revival is pending — any later status change clears
	 * it — so `failed` with `restartAt` set means "down, but coming back on its
	 * own" and nobody downstream has to treat it as terminal.
	 */
	restartAt?: number
	/** 1-based attempt number of the queued revival. */
	restartAttempt?: number
	/** Retry budget the queued revival counts against. */
	restartMaxRetries?: number
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
