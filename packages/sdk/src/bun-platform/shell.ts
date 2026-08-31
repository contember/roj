/**
 * Bun/Node ShellRunner — spawns one command line and buffers what it prints.
 *
 * Confinement is `paths`: bubblewrap mounts exactly the paths the caller
 * granted, at the location the caller says the command sees them.
 */

import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import type { ProcessRunner, ShellGrant, ShellLimits, ShellRunner, ShellRunOptions, ShellRunResult } from '../platform/index.js'
import { createBunProcessRunner } from './process.js'

/** Maximum output size per stream in bytes (1 MB) */
const MAX_OUTPUT_BYTES = 1_048_576

/** Default cap on what a confined command may write (200 MB). */
const DEFAULT_FILE_SIZE_BYTES = 209_715_200

/** Default process cap. Namespace-local only on Linux 5.14+; older kernels count per host uid. */
const DEFAULT_PROCESSES = 64

/** POSIX counts `ulimit -f` in 512-byte blocks; a shell counting 1024 caps at twice the request. */
const FILE_SIZE_BLOCK_BYTES = 512

/** Marks a limit the shell refused, so the host hears about it and the agent's stderr stays clean */
const LIMIT_NOTICE_PREFIX = 'roj-shell: limit unavailable:'

const reportedLimits = new Set<string>()

/** Grace period before SIGKILL after SIGTERM (ms) */
const GRACEFUL_KILL_DELAY_MS = 5000

/** Host environment a command inherits; everything else stays out of it. */
const SAFE_ENV_VARS = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TZ']

function getSafeEnv(): Record<string, string> {
	return Object.fromEntries(
		SAFE_ENV_VARS
			.filter(key => process.env[key])
			.map(key => [key, process.env[key]!]),
	)
}

/** A command the host could not run, carrying whatever it managed to observe. */
class ShellRunFailure extends Error {
	constructor(message: string, readonly details: Record<string, unknown>) {
		super(message)
		this.name = 'ShellRunFailure'
	}
}

export interface BwrapOptions {
	/** Command line to run inside the sandbox. */
	command: string
	/** Working directory, as the command sees it. */
	cwd: string
	/** What the command may reach; mounted in the order given. */
	grants?: readonly ShellGrant[]
	/** Allow network access (default: false) */
	network?: boolean
}

export function buildBwrapArgs(opts: BwrapOptions): string[] {
	const args: string[] = [
		'--ro-bind',
		'/',
		'/',
		'--dev',
		'/dev',
		'--proc',
		'/proc',
		'--tmpfs',
		'/tmp',
	]

	// Overrides --ro-bind / / for these paths, keeping user home dirs and root out of reach
	args.push('--tmpfs', '/home')
	args.push('--tmpfs', '/root')

	for (const grant of opts.grants ?? []) {
		args.push(grant.mode === 'ro' ? '--ro-bind' : '--bind', resolve(grant.source ?? grant.path), grant.path)
	}

	args.push('--unshare-all')

	if (opts.network) {
		args.push('--share-net')
	}

	args.push('--die-with-parent')

	// Set working directory inside the namespace
	args.push('--chdir', opts.cwd)

	args.push('/bin/sh', '-c', opts.command)

	return args
}

/**
 * Resource limits for a confined command, one statement at a time: dash fails a single
 * `ulimit` call carrying several flags, and spells the process cap `-p`, not `-u`.
 * `-v` and `-t` stay unset; the shell port documents why.
 */
export function buildLimitPrefix(limits: ShellLimits = {}): string {
	const fileSizeBytes = limits.fileSizeBytes === undefined ? DEFAULT_FILE_SIZE_BYTES : limits.fileSizeBytes
	const processes = limits.processes === undefined ? DEFAULT_PROCESSES : limits.processes
	const statements: [string, string][] = []
	if (fileSizeBytes !== null) {
		statements.push(['file size', `ulimit -f ${Math.ceil(fileSizeBytes / FILE_SIZE_BLOCK_BYTES)}`])
	}
	if (processes !== null) {
		statements.push(['process count', `{ ulimit -u ${processes} 2>/dev/null || ulimit -p ${processes} 2>/dev/null; }`])
	}
	return statements
		.map(([name, attempt]) => `${attempt} || echo '${LIMIT_NOTICE_PREFIX} ${name}' >&2`)
		.join('\n')
}

/** Every limit turned off leaves no prefix, and the command must not gain a blank first line. */
function prefixCommand(prefix: string, command: string): string {
	return prefix === '' ? command : `${prefix}\n${command}`
}

/** Split the notices the prefix wrote from the command's own stderr. */
export function splitLimitNotices(stderr: string): { stderr: string; unavailable: string[] } {
	const unavailable: string[] = []
	const lines = stderr.split('\n')
	let index = 0
	while (index < lines.length && lines[index].startsWith(LIMIT_NOTICE_PREFIX)) {
		unavailable.push(lines[index].slice(LIMIT_NOTICE_PREFIX.length).trim())
		index++
	}
	return { stderr: lines.slice(index).join('\n'), unavailable }
}

function reportUnavailableLimits(names: string[], warn: (message: string) => void): void {
	for (const name of names) {
		if (reportedLimits.has(name)) continue
		reportedLimits.add(name)
		warn(`shell: this shell applies no ${name} limit; commands run without it`)
	}
}

/** Host directory the bwrap process itself starts from; the namespace has its own cwd. */
function hostStartDir(options: ShellRunOptions): string | undefined {
	const first = options.grants?.[0]
	return first ? first.source ?? first.path : undefined
}

function runCommand(
	processRunner: ProcessRunner,
	options: ShellRunOptions,
	warn: (message: string) => void,
): Promise<ShellRunResult> {
	// The grants are the confinement request: without them the command runs unconfined.
	const confined = options.grants !== undefined
	const startTime = Date.now()

	return new Promise<ShellRunResult>((settleResult, failResult) => {
		let stdout = ''
		let stderr = ''
		let timedOut = false
		let processClosed = false
		let processError: Error | undefined
		let exitCode: number | null = null
		let exitSignal: NodeJS.Signals | null = null
		let stdinSettled = options.stdin === undefined
		let stdinError: Error | undefined
		let settled = false

		const env = { ...getSafeEnv(), ...options.env }

		let child: ChildProcess
		if (confined) {
			// The prefix runs in the command's own shell: wrap it in a subshell and it limits nothing.
			const bwrapArgs = buildBwrapArgs({
				command: prefixCommand(buildLimitPrefix(options.limits), options.command),
				cwd: options.cwd,
				grants: options.grants,
				network: options.network,
			})
			child = processRunner.spawn('bwrap', bwrapArgs, {
				cwd: hostStartDir(options),
				env,
				detached: true,
			})
		} else {
			const shell = options.shell ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
			const shellFlag = process.platform === 'win32' ? '/c' : '-c'

			child = processRunner.spawn(shell, [shellFlag, options.command], {
				cwd: options.cwd,
				env,
				detached: true,
			})
		}

		// Collect stdout with size cap
		let stdoutBytes = 0
		let stdoutTruncated = false
		child.stdout?.on('data', (data: Buffer) => {
			if (stdoutTruncated) return
			const remaining = MAX_OUTPUT_BYTES - stdoutBytes
			if (data.length > remaining) {
				stdout += data.toString('utf-8', 0, remaining)
				stdoutBytes = MAX_OUTPUT_BYTES
				stdoutTruncated = true
				stdout += '\n[stdout truncated at 1 MB]'
			} else {
				stdout += data.toString()
				stdoutBytes += data.length
			}
		})

		// Collect stderr with size cap
		let stderrBytes = 0
		let stderrTruncated = false
		child.stderr?.on('data', (data: Buffer) => {
			if (stderrTruncated) return
			const remaining = MAX_OUTPUT_BYTES - stderrBytes
			if (data.length > remaining) {
				stderr += data.toString('utf-8', 0, remaining)
				stderrBytes = MAX_OUTPUT_BYTES
				stderrTruncated = true
				stderr += '\n[stderr truncated at 1 MB]'
			} else {
				stderr += data.toString()
				stderrBytes += data.length
			}
		})

		// Timeout handler — SIGTERM first, then SIGKILL after grace period
		let killTimeoutId: ReturnType<typeof setTimeout> | undefined
		const clearTimers = () => {
			clearTimeout(timeoutId)
			if (killTimeoutId) clearTimeout(killTimeoutId)
		}
		const finishExecution = () => {
			if (settled) return
			if (!processClosed) return

			const durationMs = Date.now() - startTime
			if (processError) {
				settled = true
				clearTimers()
				failResult(new ShellRunFailure(`Failed to execute command: ${processError.message}`, { durationMs }))
				return
			}

			if (!stdinSettled) return

			settled = true
			clearTimers()
			const notices = splitLimitNotices(stderr)
			reportUnavailableLimits(notices.unavailable, warn)
			const commandStderr = notices.stderr.trim()
			if (stdinError) {
				failResult(new ShellRunFailure(`Failed to deliver command stdin: ${stdinError.message}`, {
					stdout: stdout.trim(),
					stderr: commandStderr,
					durationMs,
					exitCode: exitCode ?? -1,
					signal: exitSignal ?? undefined,
					timedOut,
				}))
				return
			}

			settleResult({
				stdout: stdout.trim(),
				stderr: commandStderr,
				exitCode: exitCode ?? -1,
				signal: exitSignal ?? undefined,
				timedOut,
				truncated: stdoutTruncated || stderrTruncated,
			})
		}
		const timeoutId = setTimeout(() => {
			timedOut = true
			try {
				process.kill(-child.pid!, 'SIGTERM')
			} catch {
				child.kill('SIGTERM')
			}
			killTimeoutId = setTimeout(() => {
				try {
					process.kill(-child.pid!, 'SIGKILL')
				} catch {
					try {
						child.kill('SIGKILL')
					} catch { /* already dead */ }
				}
			}, GRACEFUL_KILL_DELAY_MS)
		}, options.timeoutMs)

		// Process exit
		child.on('close', (code, signal) => {
			processClosed = true
			exitCode = code
			exitSignal = signal
			if (options.stdin !== undefined && !stdinSettled) {
				if (child.stdin?.writableFinished) {
					stdinSettled = true
				} else {
					stdinError = new Error('child process closed before accepting all stdin input')
					stdinSettled = true
				}
			}
			finishExecution()
		})

		// Process error
		child.on('error', (error) => {
			processError = error
			finishExecution()
		})

		// A failed stdin write must not be hidden by a successful process exit.
		if (options.stdin !== undefined) {
			if (!child.stdin) {
				stdinError = new Error('child process stdin is unavailable')
				stdinSettled = true
			} else {
				child.stdin.once('finish', () => {
					if (stdinSettled) return
					stdinSettled = true
					finishExecution()
				})
				child.stdin.on('error', (error) => {
					if (stdinSettled) return
					stdinError = error
					stdinSettled = true
					finishExecution()
				})
				child.stdin.once('close', () => {
					if (stdinSettled) return
					stdinError = new Error('child process stdin closed before accepting all input')
					stdinSettled = true
					finishExecution()
				})
				child.stdin.end(options.stdin)
			}
		} else {
			// Keep late pipe errors contained when no input delivery was requested.
			child.stdin?.on('error', () => {})
			child.stdin?.end()
		}
		finishExecution()
	})
}

export function createBunShellRunner(
	processRunner: ProcessRunner = createBunProcessRunner(),
	/** Where a limit this shell refused is reported; the command's own stderr never carries it. */
	warn: (message: string) => void = (message) => console.warn(message),
): ShellRunner {
	return {
		confinement: 'paths',
		run: (options) => runCommand(processRunner, options, warn),
	}
}
