/**
 * SessionFileStore - single FileStore implementation with path resolution.
 *
 * Encapsulates all path resolution logic (sandboxed virtual paths, traversal
 * validation, agent-visible path mapping). Replaces the separate path-resolver
 * functions for FileStore consumers.
 *
 * Three scopes:
 * - 'full': accepts agent-visible paths (/home/user/session/... or real paths)
 * - 'session': paths relative to sessionDir
 * - 'workspace': paths relative to workspaceDir
 */

import { dirname, join, normalize, resolve } from 'node:path'
import type { FileEntry, FileStore } from '~/core/file-store/types.js'
import type { FileSystem } from '~/platform/fs.js'
import { Err, Ok } from '~/lib/utils/result.js'
import type { Result } from '~/lib/utils/result.js'

// Virtual roots for sandboxed mode
const VIRTUAL_SESSION = '/home/user/session'
const VIRTUAL_WORKSPACE = '/home/user/workspace'

type FileStoreScope = 'full' | 'session' | 'workspace'

export class SessionFileStore implements FileStore {
	constructor(
		private readonly sessionDir: string,
		private readonly workspaceDir: string | undefined,
		private readonly sandboxed: boolean,
		private readonly fs: FileSystem,
		private readonly scope: FileStoreScope = 'full',
	) {}

	/** Create a session-scoped FileStore (relative paths → sessionDir) */
	get session(): SessionFileStore {
		return new SessionFileStore(this.sessionDir, this.workspaceDir, this.sandboxed, this.fs, 'session')
	}

	/** Create a workspace-scoped FileStore (relative paths → workspaceDir), or undefined if no workspace */
	get workspace(): SessionFileStore | undefined {
		if (!this.workspaceDir) return undefined
		return new SessionFileStore(this.sessionDir, this.workspaceDir, this.sandboxed, this.fs, 'workspace')
	}

	async write(path: string, content: string | Buffer): Promise<Result<{ path: string }, string>> {
		const resolved = this.resolvePath(path)
		if (!resolved.ok) return resolved

		await this.fs.mkdir(dirname(resolved.value), { recursive: true })
		await this.fs.writeFile(resolved.value, content)

		return Ok({ path: this.toAgentPath(resolved.value) })
	}

	async read(path: string): Promise<Result<string, string>>
	async read(path: string, opts: { type: 'buffer' }): Promise<Result<Buffer, string>>
	async read(path: string, opts?: { type: 'buffer' }): Promise<Result<string | Buffer, string>> {
		const resolved = this.resolvePath(path)
		if (!resolved.ok) return resolved

		try {
			if (opts?.type === 'buffer') {
				return Ok(await this.fs.readFile(resolved.value))
			}
			return Ok(await this.fs.readFile(resolved.value, 'utf-8'))
		} catch {
			return Err(`File not found: ${path}`)
		}
	}

	async exists(path: string): Promise<Result<boolean, string>> {
		const resolved = this.resolvePath(path)
		if (!resolved.ok) return resolved

		return Ok(await this.fs.exists(resolved.value))
	}

	async stat(path: string): Promise<Result<FileEntry, string>> {
		const resolved = this.resolvePath(path)
		if (!resolved.ok) return resolved

		try {
			const s = await this.fs.stat(resolved.value)
			return Ok({
				size: s.size,
				type: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'other',
				name: resolved.value.split('/').pop() || '',
			})
		} catch {
			return Err(`Not found: ${path}`)
		}
	}

	async list(path: string): Promise<Result<FileEntry[], string>> {
		const resolved = this.resolvePath(path)
		if (!resolved.ok) return resolved

		try {
			const items = await this.fs.readdir(resolved.value, { withFileTypes: true })
			const entries: FileEntry[] = []
			for (const item of items) {
				let type: FileEntry['type']
				let size: number | undefined
				if (item.isFile()) {
					type = 'file'
					const s = await this.fs.stat(join(resolved.value, item.name))
					size = s.size
				} else if (item.isDirectory()) {
					type = 'directory'
				} else if (item.isSymbolicLink()) {
					type = 'symlink'
				} else {
					type = 'other'
				}
				entries.push({ name: item.name, type, size })
			}
			return Ok(entries)
		} catch {
			return Err(`Directory not found: ${path}`)
		}
	}

	async remove(path: string): Promise<Result<void, string>> {
		const resolved = this.resolvePath(path)
		if (!resolved.ok) return resolved

		try {
			await this.fs.unlink(resolved.value)
			return Ok(undefined)
		} catch {
			return Err(`Failed to remove: ${path}`)
		}
	}

	getRoots(): { session: string; workspace?: string } {
		if (this.sandboxed) {
			return {
				session: VIRTUAL_SESSION,
				workspace: this.workspaceDir ? VIRTUAL_WORKSPACE : undefined,
			}
		}
		return {
			session: this.sessionDir,
			workspace: this.workspaceDir,
		}
	}

	realPath(path: string): Result<string, string> {
		return this.resolvePath(path)
	}

	scoped(basePath: string): SessionFileStore {
		// Resolve basePath relative to current scope
		const resolved = this.resolvePath(basePath)
		if (!resolved.ok) {
			throw new Error(`Cannot scope to invalid path: ${basePath}`)
		}
		return new SessionFileStore(resolved.value, undefined, false, this.fs, 'session')
	}

	// ============================================================================
	// Path resolution
	// ============================================================================

	private resolvePath(path: string): Result<string, string> {
		switch (this.scope) {
			case 'full':
				return this.resolveAgentPath(path)
			case 'session':
				return this.resolveRelativePath(path, this.sessionDir)
			case 'workspace':
				if (!this.workspaceDir) return Err('No workspace directory configured')
				return this.resolveRelativePath(path, this.workspaceDir)
		}
	}

	/** Resolve a relative path within a root directory */
	private resolveRelativePath(path: string, rootDir: string): Result<string, string> {
		const normalized = normalize(path)
		if (normalized.startsWith('..') || normalized.startsWith('/')) {
			return Err(`Path traversal not allowed: ${path}`)
		}
		const absolute = resolve(join(rootDir, normalized))
		if (!absolute.startsWith(rootDir)) {
			return Err(`Path traversal not allowed: ${path}`)
		}
		return Ok(absolute)
	}

	/** Resolve an agent-visible path to real filesystem path (handles sandboxed virtual paths) */
	private resolveAgentPath(agentPath: string): Result<string, string> {
		if (this.sandboxed) {
			return this.resolveSandboxedPath(agentPath)
		}
		return this.resolveNonSandboxedPath(agentPath)
	}

	private resolveSandboxedPath(agentPath: string): Result<string, string> {
		if (agentPath.startsWith(VIRTUAL_SESSION + '/') || agentPath === VIRTUAL_SESSION) {
			const relative = agentPath.slice(VIRTUAL_SESSION.length)
			const absolutePath = resolve(this.sessionDir, relative.slice(1) || '.')
			return this.validateWithinRoot(absolutePath, this.sessionDir, agentPath)
		}

		if (agentPath.startsWith(VIRTUAL_WORKSPACE + '/') || agentPath === VIRTUAL_WORKSPACE) {
			if (!this.workspaceDir) {
				return Err('No workspace directory is configured for this session. Only session paths are available.')
			}
			const relative = agentPath.slice(VIRTUAL_WORKSPACE.length)
			const absolutePath = resolve(this.workspaceDir, relative.slice(1) || '.')
			return this.validateWithinRoot(absolutePath, this.workspaceDir, agentPath)
		}

		const validPrefixes = this.workspaceDir
			? `${VIRTUAL_SESSION}/ or ${VIRTUAL_WORKSPACE}/`
			: `${VIRTUAL_SESSION}/`

		return Err(`Path must start with ${validPrefixes}. Got: '${agentPath}'`)
	}

	private resolveNonSandboxedPath(agentPath: string): Result<string, string> {
		const absolutePath = resolve(agentPath)
		const normalizedSession = resolve(this.sessionDir)
		const normalizedWorkspace = this.workspaceDir ? resolve(this.workspaceDir) : null

		const isInSession = absolutePath === normalizedSession || absolutePath.startsWith(normalizedSession + '/')
		const isInWorkspace = normalizedWorkspace
			&& (absolutePath === normalizedWorkspace || absolutePath.startsWith(normalizedWorkspace + '/'))

		if (!isInSession && !isInWorkspace) {
			return Err(`Path '${agentPath}' is outside allowed directories`)
		}

		return Ok(absolutePath)
	}

	private validateWithinRoot(absolutePath: string, rootDir: string, originalPath: string): Result<string, string> {
		const normalizedRoot = resolve(rootDir)
		const isWithin = absolutePath === normalizedRoot || absolutePath.startsWith(normalizedRoot + '/')

		if (!isWithin) {
			return Err(`Path '${originalPath}' resolves outside allowed directories`)
		}

		return Ok(absolutePath)
	}

	// ============================================================================
	// Agent-visible path conversion
	// ============================================================================

	private toAgentPath(realPath: string): string {
		if (!this.sandboxed) return realPath

		const normalizedSession = resolve(this.sessionDir)
		const normalizedWorkspace = this.workspaceDir ? resolve(this.workspaceDir) : null

		// Try workspace first (more specific match if workspace is inside session)
		if (normalizedWorkspace) {
			if (realPath === normalizedWorkspace) return VIRTUAL_WORKSPACE
			if (realPath.startsWith(normalizedWorkspace + '/')) {
				return VIRTUAL_WORKSPACE + realPath.slice(normalizedWorkspace.length)
			}
		}

		if (realPath === normalizedSession) return VIRTUAL_SESSION
		if (realPath.startsWith(normalizedSession + '/')) {
			return VIRTUAL_SESSION + realPath.slice(normalizedSession.length)
		}

		// Path is outside known roots - return as-is
		return realPath
	}
}
