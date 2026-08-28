/**
 * Shell adapter interface.
 *
 * The shell tool assembles and validates a command line; running it is the
 * host's business. A host with a process table spawns `/bin/sh`; one without
 * answers from an in-process interpreter over its own filesystem.
 */

/**
 * How a runner confines what a command may touch.
 *
 * `paths` honours the path lists below; `host` is a filesystem that holds
 * nothing but this session, so the lists are redundant; `none` cannot confine
 * at all, and the caller decides whether that is acceptable.
 */
export type ShellConfinement = 'paths' | 'host' | 'none'

export interface ShellRunOptions {
	/** One command line, already assembled and escaped by the caller. */
	command: string
	cwd: string
	env?: Record<string, string>
	stdin?: string
	timeoutMs: number
	/** Paths the command may write. Meaningful only under `paths` confinement. */
	writablePaths?: readonly string[]
	/** Paths the command may read but not write. Meaningful only under `paths`. */
	readablePaths?: readonly string[]
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
