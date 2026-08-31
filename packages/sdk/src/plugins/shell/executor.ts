import { isAbsolute, resolve } from 'node:path'
import type { SessionEnvironment } from '~/core/sessions/session-environment.js'
import type { ToolError } from '~/core/tools/executor.js'
import { Err, Ok, type Result } from '~/lib/utils/result.js'
import type { FileSystem } from '~/platform/fs.js'
import type { ShellGrant, ShellLimits, ShellRunner, ShellRunOptions } from '~/platform/shell.js'

// ============================================================================
// Constants
// ============================================================================

const VIRTUAL_SESSION = '/home/user/session'
const VIRTUAL_WORKSPACE = '/home/user/workspace'

/** The sandbox covers these with a tmpfs, so only what a grant mounts back exists under them. */
const HIDDEN_ROOTS = ['/home', '/root']

function isWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(root + '/')
}

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
	/** Resource caps for the confined command; a `null` field asks for no cap. */
	limits?: ShellLimits
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
	/** Absent on a host with no shell at all — every command then fails with a clear error. */
	shell?: ShellRunner
}

export class ShellExecutor {
	private readonly fs: FileSystem
	private readonly shell?: ShellRunner

	constructor(private config: ShellConfig, deps: ShellExecutorDeps) {
		this.fs = deps.fs
		this.shell = deps.shell
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

		const shell = this.shell
		if (!shell) {
			return Err({
				message: 'This host cannot run shell commands: it has no shell.',
				recoverable: false,
			})
		}
		if (sandboxEnabled && shell.confinement === 'none') {
			return Err({
				message: 'This session runs commands sandboxed, but the host shell cannot confine them.',
				recoverable: false,
			})
		}
		// A `host` shell needs no grants: its filesystem holds nothing but this session.
		const confineByPaths = sandboxEnabled && shell.confinement === 'paths'

		// A sandboxed agent sends virtual paths: the shell presents them, or we resolve them here.
		let cwd: string
		if (sandboxEnabled) {
			const cwdResult = await this.resolveSandboxCwd(input.cwd ?? VIRTUAL_SESSION, sessionDir, workspaceDir)
			if (!cwdResult.ok) return cwdResult
			cwd = cwdResult.value
		} else if (this.config.sandboxed && input.cwd) {
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

		const runOptions: ShellRunOptions = {
			command: fullCommand,
			cwd,
			env: this.config.env,
			stdin: input.stdin,
			timeoutMs: timeout,
			shell: this.config.shell,
		}
		if (confineByPaths) {
			runOptions.grants = this.grants(cwd, sessionDir, workspaceDir)
			runOptions.network = this.config.sandbox?.network
			runOptions.limits = this.config.sandbox?.limits
		}

		try {
			const result = await shell.run(runOptions)
			return Ok({
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
				durationMs: Date.now() - startTime,
			})
		} catch (error) {
			const durationMs = Date.now() - startTime
			const message = error instanceof Error ? error.message : String(error)
			return Err({
				message,
				recoverable: false,
				details: error instanceof Error && 'details' in error ? error.details : { durationMs },
			})
		}
	}

	/**
	 * Keep the working directory inside what the sandbox mounts, before the host chdirs into it.
	 * Paths under the hidden home roots exist only where a grant mounts them back; the rest of
	 * the tree the sandbox binds read-only, so a directory there grants nothing.
	 */
	private async resolveSandboxCwd(
		agentCwd: string,
		sessionDir: string,
		workspaceDir: string | undefined,
	): Promise<Result<string, ToolError>> {
		if (!isAbsolute(agentCwd)) {
			return Err({ message: `Working directory '${agentCwd}' must be an absolute path`, recoverable: false })
		}
		const normalized = resolve(agentCwd)

		if (isWithin(normalized, VIRTUAL_SESSION) || isWithin(normalized, VIRTUAL_WORKSPACE)) {
			const contained = await resolveAgentPath(this.fs, normalized, sessionDir, workspaceDir, true)
			if (!contained.ok) return contained
			return this.requireExists(contained.value, agentCwd, normalized)
		}

		for (const root of this.boundRoots()) {
			if (!isWithin(normalized, root.seen)) continue
			const hostPath = resolve(root.host + normalized.slice(root.seen.length))
			if (await checkSymlinkEscape(this.fs, hostPath, root.host)) {
				return Err({ message: `Path '${agentCwd}' resolves outside its bind mount via symlink`, recoverable: false })
			}
			return this.requireExists(hostPath, agentCwd, normalized)
		}

		if (HIDDEN_ROOTS.some((root) => isWithin(normalized, root))) {
			const mounted = [
				VIRTUAL_SESSION,
				...(workspaceDir ? [VIRTUAL_WORKSPACE] : []),
				...this.boundRoots().map((root) => root.seen),
			]
			return Err({
				message: `Path '${agentCwd}' is not mounted in this sandbox. Mounted roots: ${mounted.join(', ')}`,
				recoverable: false,
			})
		}

		return Ok(normalized)
	}

	private async requireExists(hostPath: string, agentCwd: string, seen: string): Promise<Result<string, ToolError>> {
		if (await this.fs.exists(hostPath)) return Ok(seen)
		return Err({ message: `Working directory '${agentCwd}' does not exist`, recoverable: false })
	}

	/** Granted roots beyond the session and workspace, as the command sees them and where the host keeps them. */
	private boundRoots(): { seen: string; host: string }[] {
		return [
			...(this.config.extraBinds ?? []).map((bind) => ({ seen: resolve(bind.destPath ?? bind.path), host: resolve(bind.path) })),
			...(this.config.sandbox?.writablePaths ?? []).map((path) => ({ seen: resolve(path), host: resolve(path) })),
		]
	}

	/** Session and workspace keep their agent-visible names; everything else stays where it is. */
	private grants(cwd: string, sessionDir: string, workspaceDir: string | undefined): ShellGrant[] {
		const grants: ShellGrant[] = []

		if (sessionDir) {
			grants.push({ path: VIRTUAL_SESSION, source: sessionDir, mode: 'rw' })
		}
		if (workspaceDir) {
			grants.push({ path: VIRTUAL_WORKSPACE, source: workspaceDir, mode: 'rw' })
		}

		// Extra binds (e.g. git project dir for worktree support, .gitconfig)
		for (const bind of this.config.extraBinds ?? []) {
			grants.push({ path: bind.destPath ?? bind.path, source: bind.path, mode: bind.mode })
		}

		// Additional writable paths (legacy support)
		for (const path of this.config.sandbox?.writablePaths ?? []) {
			grants.push({ path, mode: 'rw' })
		}

		if (!sessionDir && !workspaceDir) {
			grants.push({ path: cwd, mode: 'rw' })
		}

		return grants
	}
}
