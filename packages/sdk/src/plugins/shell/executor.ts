import { resolve } from 'node:path'
import type { SessionEnvironment } from '~/core/sessions/session-environment.js'
import type { ToolError } from '~/core/tools/executor.js'
import { Err, Ok, type Result } from '~/lib/utils/result.js'
import type { FileSystem } from '~/platform/fs.js'
import type { ChildProcess, ProcessRunner } from '~/platform/process.js'

// ============================================================================
// Constants
// ============================================================================

const VIRTUAL_SESSION = '/home/user/session'
const VIRTUAL_WORKSPACE = '/home/user/workspace'

/** Maximum output size per stream in bytes (1 MB) */
const MAX_OUTPUT_BYTES = 1_048_576

/** Grace period before SIGKILL after SIGTERM (ms) */
const GRACEFUL_KILL_DELAY_MS = 5000

// ============================================================================
// Shell escaping
// ============================================================================

function shellEscape(arg: string): string {
	if (arg.length === 0) return "''"
	if (/^[a-zA-Z0-9_./:=@%^,+-]+$/.test(arg)) return arg
	return "'" + arg.replace(/'/g, "'\\''") + "'"
}

// ============================================================================
// Symlink escape detection
// ============================================================================

/**
 * Check if a resolved path escapes allowed directories via symlinks.
 * Returns true if escape detected (real path outside all allowed roots).
 */
async function checkSymlinkEscape(fs: FileSystem, resolvedPath: string, ...allowedRoots: (string | null | undefined)[]): Promise<boolean> {
	try {
		const realPath = await fs.realpath(resolvedPath)
		for (const root of allowedRoots) {
			if (!root) continue
			const realRoot = await fs.realpath(root)
			if (realPath === realRoot || realPath.startsWith(realRoot + '/')) {
				return false // Within bounds
			}
		}
		return true // Escaped
	} catch {
		return false // Path doesn't exist yet — no symlink to exploit
	}
}

// ============================================================================
// Path resolution
// ============================================================================

async function resolveAgentPath(
	fs: FileSystem,
	agentPath: string,
	sessionDir: string,
	workspaceDir: string | undefined,
	sandboxed: boolean,
): Promise<Result<string, ToolError>> {
	if (sandboxed) {
		if (agentPath.startsWith(VIRTUAL_SESSION + '/') || agentPath === VIRTUAL_SESSION) {
			const rel = agentPath.slice(VIRTUAL_SESSION.length)
			const absolutePath = resolve(sessionDir, rel.slice(1) || '.')
			const normalizedRoot = resolve(sessionDir)
			if (absolutePath !== normalizedRoot && !absolutePath.startsWith(normalizedRoot + '/')) {
				return Err({ message: `Path '${agentPath}' resolves outside allowed directories`, recoverable: false })
			}
			if (await checkSymlinkEscape(fs, absolutePath, sessionDir)) {
				return Err({ message: `Path '${agentPath}' resolves outside session directory via symlink`, recoverable: false })
			}
			return Ok(absolutePath)
		}
		if (agentPath.startsWith(VIRTUAL_WORKSPACE + '/') || agentPath === VIRTUAL_WORKSPACE) {
			if (!workspaceDir) {
				return Err({ message: 'No workspace directory is configured for this session.', recoverable: false })
			}
			const rel = agentPath.slice(VIRTUAL_WORKSPACE.length)
			const absolutePath = resolve(workspaceDir, rel.slice(1) || '.')
			const normalizedRoot = resolve(workspaceDir)
			if (absolutePath !== normalizedRoot && !absolutePath.startsWith(normalizedRoot + '/')) {
				return Err({ message: `Path '${agentPath}' resolves outside allowed directories`, recoverable: false })
			}
			if (await checkSymlinkEscape(fs, absolutePath, workspaceDir)) {
				return Err({ message: `Path '${agentPath}' resolves outside workspace directory via symlink`, recoverable: false })
			}
			return Ok(absolutePath)
		}
		const validPrefixes = workspaceDir
			? `${VIRTUAL_SESSION}/ or ${VIRTUAL_WORKSPACE}/`
			: `${VIRTUAL_SESSION}/`
		return Err({ message: `Path must start with ${validPrefixes}. Got: '${agentPath}'`, recoverable: false })
	}
	// Non-sandboxed: validate within allowed dirs
	const absolutePath = resolve(agentPath)
	const normalizedSession = resolve(sessionDir)
	const normalizedWorkspace = workspaceDir ? resolve(workspaceDir) : null
	const isInSession = absolutePath === normalizedSession || absolutePath.startsWith(normalizedSession + '/')
	const isInWorkspace = normalizedWorkspace
		&& (absolutePath === normalizedWorkspace || absolutePath.startsWith(normalizedWorkspace + '/'))
	if (!isInSession && !isInWorkspace) {
		return Err({ message: `Path '${agentPath}' is outside allowed directories`, recoverable: false })
	}
	if (await checkSymlinkEscape(fs, absolutePath, sessionDir, workspaceDir)) {
		return Err({ message: `Path '${agentPath}' resolves outside allowed directories via symlink`, recoverable: false })
	}
	return Ok(absolutePath)
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Extra path to bind-mount inside bwrap sandbox.
 */
export interface ExtraBind {
	/** Absolute path on the host to bind-mount */
	path: string
	/** Mount mode: 'rw' for read-write, 'ro' for read-only */
	mode: 'rw' | 'ro'
	/** Destination path inside the sandbox. Defaults to `path` (same as host). */
	destPath?: string
}

export interface SandboxConfig {
	enabled: boolean
	/** Allow network access (default: false) */
	network?: boolean
	/** Paths with read-write access (default: [cwd]) */
	writablePaths?: string[]
}

export interface ShellConfig {
	/** Working directory for commands (fallback when not sandboxed and no workspace) */
	cwd: string
	/** Command timeout in milliseconds (default: 30000) */
	timeout?: number
	/** Environment variables to add/override */
	env?: Record<string, string>
	/** Shell to use (default: sh on unix, cmd.exe on windows) */
	shell?: string
	/** Whether sandbox is active */
	sandboxed: boolean
	/** Extra paths to bind-mount inside bwrap sandbox */
	extraBinds?: ExtraBind[]
	/** Bubblewrap sandbox config (default: enabled) */
	sandbox?: SandboxConfig
}

// ============================================================================
// Environment
// ============================================================================

/** Safe environment variables that can be passed to child processes */
const SAFE_ENV_VARS = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TZ']

function getSafeEnv(): Record<string, string> {
	return Object.fromEntries(
		SAFE_ENV_VARS
			.filter(key => process.env[key])
			.map(key => [key, process.env[key]!]),
	)
}

// ============================================================================
// Sandbox
// ============================================================================

export interface BwrapOptions {
	command: string
	cwd: string
	sandbox: SandboxConfig
	/** Real session directory to map into sandbox */
	sessionDir?: string
	/** Real workspace directory to map into sandbox */
	workspaceDir?: string
	/** Extra paths to bind-mount inside sandbox */
	extraBinds?: ExtraBind[]
}

export function buildBwrapArgs(opts: BwrapOptions): string[] {
	const { command, cwd, sandbox, extraBinds } = opts
	const sessionDir = opts.sessionDir ? resolve(opts.sessionDir) : undefined
	const workspaceDir = opts.workspaceDir ? resolve(opts.workspaceDir) : undefined

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

	// Hide sensitive directories with tmpfs overlays
	// (overrides --ro-bind / / for these paths, preventing access to user home dirs and root)
	args.push('--tmpfs', '/home')
	args.push('--tmpfs', '/root')

	if (sessionDir) {
		// Map real session dir to /home/user/session (read-write)
		args.push('--bind', sessionDir, VIRTUAL_SESSION)
	}

	if (workspaceDir) {
		// Map real workspace dir to /home/user/workspace (read-write)
		args.push('--bind', workspaceDir, VIRTUAL_WORKSPACE)
	}

	// Extra bind mounts (e.g. git project dir for worktree support, .gitconfig)
	for (const bind of extraBinds ?? []) {
		args.push(bind.mode === 'ro' ? '--ro-bind' : '--bind', bind.path, bind.destPath ?? bind.path)
	}

	// Additional writable paths (legacy support)
	for (const p of sandbox.writablePaths ?? []) {
		args.push('--bind', p, p)
	}

	// If no sessionDir/workspaceDir mapping, fall back to making cwd writable
	if (!sessionDir && !workspaceDir) {
		args.push('--bind', cwd, cwd)
	}

	args.push('--unshare-all')

	if (sandbox.network) {
		args.push('--share-net')
	}

	args.push('--die-with-parent')

	// Set working directory inside the namespace
	args.push('--chdir', cwd)

	args.push('/bin/sh', '-c', command)

	return args
}

// ============================================================================
// Shell Executor
// ============================================================================

export interface RunCommandInput {
	command: string
	args?: string | string[]
	cwd?: string
	timeout?: number
	stdin?: string
}

export interface ShellResult {
	stdout: string
	stderr: string
	exitCode: number
	signal?: string
	timedOut: boolean
	durationMs: number
}

export interface ShellExecutorDeps {
	fs: FileSystem
	process: ProcessRunner
}

export class ShellExecutor {
	private readonly fs: FileSystem
	private readonly process: ProcessRunner

	constructor(private config: ShellConfig, deps: ShellExecutorDeps) {
		this.fs = deps.fs
		this.process = deps.process
	}

	async execute(
		input: RunCommandInput,
		environment: SessionEnvironment,
	): Promise<Result<ShellResult, ToolError>> {
		const args = typeof input.args === 'string' ? [input.args] : input.args
		const fullCommand = args
			? `${shellEscape(input.command)} ${args.map(shellEscape).join(' ')}`
			: input.command

		const timeout = input.timeout ?? this.config.timeout ?? 30000
		const startTime = Date.now()

		// Resolve directories from environment
		const sessionDir = environment.sessionDir
		const workspaceDir = environment.workspaceDir

		// Determine sandbox mode from config
		const sandboxEnabled = this.config.sandboxed && this.config.sandbox?.enabled !== false

		// Resolve cwd based on sandbox mode:
		// - bwrap enabled: use virtual path (bwrap handles mapping)
		// - sandboxed but no bwrap: agent sends virtual paths, resolve to real paths
		// - not sandboxed: agent sends real paths, use as-is
		let cwd: string
		if (sandboxEnabled) {
			cwd = input.cwd ?? VIRTUAL_SESSION
		} else if (this.config.sandboxed && input.cwd) {
			// Sandboxed env but bwrap disabled — resolve virtual paths to real paths
			const cwdResult = await resolveAgentPath(this.fs, input.cwd, sessionDir, workspaceDir, this.config.sandboxed)
			if (!cwdResult.ok) return cwdResult
			cwd = cwdResult.value
		} else {
			cwd = input.cwd ?? workspaceDir ?? this.config.cwd
		}

		// Validate directories exist before sandbox bind mount
		if (sandboxEnabled) {
			if (sessionDir && !(await this.fs.exists(sessionDir))) {
				return Err({
					message: `Session directory does not exist: ${sessionDir}`,
					recoverable: false,
				})
			}
			if (workspaceDir && !(await this.fs.exists(workspaceDir))) {
				return Err({
					message: `Workspace directory does not exist: ${workspaceDir}`,
					recoverable: false,
				})
			}
		}

		return new Promise<Result<ShellResult, ToolError>>((resolve) => {
			let stdout = ''
			let stderr = ''
			let timedOut = false

			let child: ChildProcess
			if (sandboxEnabled) {
				// Apply resource limits inside the sandbox
				const timeoutSeconds = Math.ceil(timeout / 1000)
				const sandboxCommand = `ulimit -v 524288 -f 204800 -u 64 -t ${timeoutSeconds} 2>/dev/null; ${fullCommand}`
				const bwrapArgs = buildBwrapArgs({
					command: sandboxCommand,
					cwd,
					sandbox: this.config.sandbox ?? { enabled: true },
					sessionDir,
					workspaceDir,
					extraBinds: this.config.extraBinds,
				})
				child = this.process.spawn('bwrap', bwrapArgs, {
					cwd: sessionDir ?? this.config.cwd,
					env: { ...getSafeEnv(), ...this.config.env },
					detached: true,
				})
			} else {
				const shell = this.config.shell ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
				const shellFlag = process.platform === 'win32' ? '/c' : '-c'

				child = this.process.spawn(shell, [shellFlag, fullCommand], {
					cwd,
					env: { ...getSafeEnv(), ...this.config.env },
					detached: true,
				})
			}

			// Handle stdin
			if (input.stdin) {
				child.stdin?.write(input.stdin)
				child.stdin?.end()
			} else {
				child.stdin?.end()
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
			}, timeout)

			// Process exit
			child.on('close', (code, signal) => {
				clearTimeout(timeoutId)
				if (killTimeoutId) clearTimeout(killTimeoutId)
				const durationMs = Date.now() - startTime

				resolve(Ok({
					stdout: stdout.trim(),
					stderr: stderr.trim(),
					exitCode: code ?? -1,
					signal: signal ?? undefined,
					timedOut,
					durationMs,
				}))
			})

			// Process error
			child.on('error', (error) => {
				clearTimeout(timeoutId)
				if (killTimeoutId) clearTimeout(killTimeoutId)
				const durationMs = Date.now() - startTime

				resolve(Err({
					message: `Failed to execute command: ${error.message}`,
					recoverable: false,
					details: { durationMs },
				}))
			})
		})
	}
}
