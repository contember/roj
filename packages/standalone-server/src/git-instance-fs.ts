/**
 * Per-instance git layout for the standalone server.
 *
 * Mirrors what `roj-platform` does inside an E2B sandbox: each instance owns
 * a bare repo, each session owns a worktree branched from `main`. The SDK
 * receives the worktree path as `workspaceDir` on `sessions.create` and treats
 * it as an opaque directory — it doesn't know about git.
 *
 *   {dataPath}/instances/{instanceId}/repo.git/        ← bare, branch `main`
 *   {dataPath}/instances/{instanceId}/sessions/{sid}/  ← worktree, branch `session/{sid}`
 *
 * Why a bare repo + worktrees instead of a plain dir per session:
 *  - Parallel sessions on one instance need independent commit history.
 *  - `git worktree` shares object storage, so the cost is mostly metadata.
 *  - Mental model matches platform — agent `git status` / `git log` behave
 *    identically against standalone and against E2B.
 *
 * Idempotent: `initInstance` skips if `repo.git` already exists,
 * `addSessionWorktree` skips if the target worktree is already registered.
 * That keeps `roj-standalone` restart-safe — bare repos and worktrees on disk
 * persist across process restarts the same way `LocalRegistry` does.
 *
 * No auto-commit. Resources extracted via `resources.inject` land in the
 * worktree as untracked files; whether to commit them is the agent's call,
 * matching platform behavior.
 */

import type { Logger } from '@roj-ai/sdk'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Used for the empty initial commit on `main`. Real commits the agent makes
// will pick up the host's git config; this just keeps `commit-tree` from
// failing on machines without `user.name`/`user.email` set.
const BOOTSTRAP_GIT_ENV = {
	GIT_AUTHOR_NAME: 'roj-standalone',
	GIT_AUTHOR_EMAIL: 'standalone@roj.local',
	GIT_COMMITTER_NAME: 'roj-standalone',
	GIT_COMMITTER_EMAIL: 'standalone@roj.local',
}

export class GitInstanceFs {
	constructor(
		private readonly dataPath: string,
		private readonly logger: Logger,
	) {}

	instanceDir(instanceId: string): string {
		return join(this.dataPath, 'instances', instanceId)
	}

	repoDir(instanceId: string): string {
		return join(this.instanceDir(instanceId), 'repo.git')
	}

	worktreeDir(instanceId: string, sessionId: string): string {
		return join(this.instanceDir(instanceId), 'sessions', sessionId)
	}

	/**
	 * Idempotently initialize the bare repo for an instance with an empty
	 * initial commit on `main`. The commit exists so subsequent
	 * `git worktree add -b session/{sid}` calls have something to branch from.
	 */
	async initInstance(instanceId: string): Promise<void> {
		const repoDir = this.repoDir(instanceId)
		if (existsSync(repoDir)) {
			this.logger.debug('Instance bare repo already exists, skipping init', { instanceId })
			return
		}

		await mkdir(this.instanceDir(instanceId), { recursive: true })
		await this.git(['init', '--bare', repoDir])
		// `git init --bare` may default to `master` on older git; normalize so
		// the worktree branch starts from a known parent ref.
		await this.git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repoDir })

		const tree = (await this.git(['mktree'], { cwd: repoDir, input: '' })).trim()
		const commit = (await this.git(
			['commit-tree', tree, '-m', 'Initial commit'],
			{ cwd: repoDir, env: BOOTSTRAP_GIT_ENV },
		)).trim()
		await this.git(['update-ref', 'refs/heads/main', commit], { cwd: repoDir })

		this.logger.info('Initialized instance bare repo', { instanceId, repoDir })
	}

	/**
	 * Idempotently add a worktree for `sessionId` on branch `session/{sid}`,
	 * branching from `main`. Throws if the target dir exists but is not a valid
	 * worktree of this instance's bare repo (unrecoverable conflict).
	 */
	async addSessionWorktree(instanceId: string, sessionId: string): Promise<string> {
		const repoDir = this.repoDir(instanceId)
		const worktreePath = this.worktreeDir(instanceId, sessionId)

		if (!existsSync(repoDir)) {
			throw new Error(`Cannot add session worktree: instance bare repo missing at ${repoDir}`)
		}

		if (existsSync(worktreePath)) {
			if (await this.isLinkedWorktree(repoDir, worktreePath)) {
				this.logger.debug('Session worktree already exists, skipping add', { instanceId, sessionId })
				return worktreePath
			}
			throw new Error(`Path exists but is not a registered worktree of ${repoDir}: ${worktreePath}`)
		}

		await mkdir(join(this.instanceDir(instanceId), 'sessions'), { recursive: true })
		await this.git(
			['worktree', 'add', '-b', `session/${sessionId}`, worktreePath, 'main'],
			{ cwd: repoDir },
		)
		this.logger.info('Added session worktree', { instanceId, sessionId, worktreePath })
		return worktreePath
	}

	/**
	 * Remove a session's worktree (filesystem + bookkeeping). Silently no-ops
	 * if the worktree was never registered.
	 */
	async removeSessionWorktree(instanceId: string, sessionId: string): Promise<void> {
		const repoDir = this.repoDir(instanceId)
		const worktreePath = this.worktreeDir(instanceId, sessionId)

		if (!existsSync(repoDir) || !existsSync(worktreePath)) return

		try {
			await this.git(['worktree', 'remove', '--force', worktreePath], { cwd: repoDir })
		} catch (err) {
			// worktree may already be detached; fall back to filesystem rm + prune.
			this.logger.warn('git worktree remove failed, falling back to rm + prune', {
				instanceId,
				sessionId,
				error: err instanceof Error ? err.message : String(err),
			})
			await rm(worktreePath, { recursive: true, force: true })
			await this.git(['worktree', 'prune'], { cwd: repoDir }).catch(() => {})
		}
	}

	/**
	 * Tear down everything for an instance: every worktree, then the
	 * bare repo + on-disk dir. Safe to call when nothing exists.
	 */
	async removeInstance(instanceId: string): Promise<void> {
		const dir = this.instanceDir(instanceId)
		if (!existsSync(dir)) return
		await rm(dir, { recursive: true, force: true })
		this.logger.info('Removed instance directory', { instanceId, dir })
	}

	private async isLinkedWorktree(repoDir: string, worktreePath: string): Promise<boolean> {
		try {
			const stdout = await this.git(['worktree', 'list', '--porcelain'], { cwd: repoDir })
			// `worktree` lines look like: `worktree /abs/path` (one per registration).
			return stdout
				.split('\n')
				.some((line) => line.startsWith('worktree ') && line.slice('worktree '.length) === worktreePath)
		} catch {
			return false
		}
	}

	private async git(
		args: string[],
		opts: { cwd?: string; input?: string; env?: Record<string, string> } = {},
	): Promise<string> {
		const env = opts.env ? { ...process.env, ...opts.env } : process.env
		const child = execFileAsync('git', args, { cwd: opts.cwd, env })
		if (opts.input !== undefined) {
			child.child.stdin?.end(opts.input)
		}
		try {
			const { stdout } = await child
			return stdout
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			throw new Error(`git ${args.join(' ')} failed: ${message}`)
		}
	}
}
