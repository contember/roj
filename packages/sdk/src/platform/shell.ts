/**
 * Shell adapter interface.
 *
 * The shell tool assembles and validates a command line; running it is the
 * host's business. A host with a process table spawns `/bin/sh`; one without
 * answers from an in-process interpreter over its own filesystem.
 *
 * Resource limits are the host's business too, and two `ulimit` values only look like
 * guards: `-v` (RLIMIT_AS) bounds mapped address space, not memory in use; `-t`
 * (RLIMIT_CPU) sums CPU across threads and resets in each child. Bound wall time instead.
 */

/**
 * How a runner confines what a command may touch.
 *
 * `paths` honours the grants below; `host` is a filesystem that holds nothing
 * but this session, so the grants are redundant; `none` cannot confine at all,
 * and the caller decides whether that is acceptable.
 */
export type ShellConfinement = 'paths' | 'host' | 'none'

/** One path the command may reach, and where the host finds it. */
export interface ShellGrant {
	/** Path as the command sees it. */
	path: string
	/**
	 * Where the host reads it from, when that differs. A runner that has to mount
	 * the confinement needs the pair; absent means the command's path is the host's.
	 */
	source?: string
	mode: 'rw' | 'ro'
}

export interface ShellRunOptions {
	/** One command line, already assembled and escaped by the caller. */
	command: string
	cwd: string
	env?: Record<string, string>
	stdin?: string
	timeoutMs: number
	/**
	 * What the command may reach. Meaningful only under `paths` confinement, and
	 * ordered: a grant is applied after the ones before it, so a later grant may
	 * narrow an earlier one.
	 */
	grants?: readonly ShellGrant[]
	/** Whether a confined command may reach the network. Default: false. */
	network?: boolean
	/** Interpreter for `command`. A host with a single interpreter ignores it. */
	shell?: string
	/** Caps for a confined command; ignored when the command runs unconfined. */
	limits?: ShellLimits
}

/**
 * Caps a host applies to a confined command. An omitted field takes the host's
 * default; `null` asks for no cap at all, for a host where one does more harm
 * than good — an old kernel that counts processes per uid rather than per namespace.
 */
export interface ShellLimits {
	/** Largest file the command may write, in bytes. */
	fileSizeBytes?: number | null
	/** Concurrent processes. On Linux this is per-uid, not per-process. */
	processes?: number | null
}

export interface ShellRunResult {
	stdout: string
	stderr: string
	exitCode: number
	/** Set when the host terminated the command rather than the command exiting. */
	signal?: string
	timedOut: boolean
	/** Set when either stream hit the host's output ceiling. */
	truncated?: boolean
}

export interface ShellRunner {
	/** Declared, not assumed: a caller that needs confinement checks it before running. */
	readonly confinement: ShellConfinement

	/**
	 * Run one command line to completion and buffer its output.
	 *
	 * Resolves with a non-zero `exitCode` rather than rejecting — a failed command
	 * is an answer. Rejects only when the host could not run it at all.
	 */
	run(options: ShellRunOptions): Promise<ShellRunResult>
}
