/**
 * Git Status Plugin
 *
 * Polls git state (commits ahead of the default branch, uncommitted files,
 * last commit metadata) inside the session's workspace directory every few
 * seconds and emits a `git_status_changed` notification when the snapshot
 * changes. The worker DO persists the last snapshot into its session table so
 * versions sidebar and publish bars can render without reaching into the
 * sandbox on every page view.
 *
 * Two ways to read that state. `platform.git` answers it directly, which is how
 * hosts with no process table (a Worker isolate over a VFS) take part; without
 * the port the plugin shells out to the `git` binary, as it always has.
 */

import z from 'zod/v4'
import { definePlugin } from '~/core/plugins/index.js'
import { sessionIdSchema } from '~/core/sessions/schema.js'
import type { GitClient } from '~/platform/git.js'
import type { ProcessRunner } from '~/platform/process.js'

const POLL_INTERVAL_MS = 2000
const GIT_TIMEOUT_MS = 5000
const DEFAULT_BRANCH_FALLBACK = 'main'

interface GitStatusSnapshot {
	committedAhead: number
	uncommittedFiles: number
	lastCommitAt: number | null
	lastCommitMessage: string | null
}

interface GitStatusPluginContext {
	intervals: Map<string, NodeJS.Timeout>
	lastSnapshots: Map<string, GitStatusSnapshot>
	defaultBranches: Map<string, string>
	active: boolean
}

export const gitStatusPlugin = definePlugin('git-status')
	.notification('git_status_changed', {
		schema: z.object({
			sessionId: sessionIdSchema,
			committedAhead: z.number(),
			uncommittedFiles: z.number(),
			lastCommitAt: z.number().nullable(),
			lastCommitMessage: z.string().nullable(),
			updatedAt: z.number(),
		}),
	})
	.context(async (): Promise<GitStatusPluginContext> => ({
		intervals: new Map(),
		lastSnapshots: new Map(),
		defaultBranches: new Map(),
		active: true,
	}))
	.sessionHook('onSessionReady', async (ctx) => {
		const workdir = ctx.sessionState.workspaceDir
		if (!workdir) return

		const sessionId = ctx.sessionId
		const pluginCtx = ctx.pluginContext
		const git = ctx.platform.git
		const processRunner = ctx.platform.process
		const logger = ctx.logger
		const notify = ctx.notify
		pluginCtx.active = true

		const stop = () => {
			const interval = pluginCtx.intervals.get(sessionId)
			if (interval) clearInterval(interval)
			pluginCtx.intervals.delete(sessionId)
		}

		const tick = async () => {
			if (!pluginCtx.active) return
			let baseBranch = pluginCtx.defaultBranches.get(sessionId)
			if (!baseBranch) {
				const detected = git
					? await detectDefaultBranchOverPort(git, workdir)
					: await detectDefaultBranch(processRunner, workdir)
				baseBranch = detected ?? DEFAULT_BRANCH_FALLBACK
				if (!pluginCtx.active) return
				pluginCtx.defaultBranches.set(sessionId, baseBranch)
			}

			const snapshot = git
				? await computeGitStatusOverPort(git, workdir, baseBranch)
				: await computeGitStatus(processRunner, workdir, baseBranch)
			if (!pluginCtx.active) return
			if (!snapshot) {
				// A workspace with no repository is an ordinary state the port reports
				// cheaply; only the shell-out path, where a failure means the binary
				// itself misbehaved, is worth a warning.
				if (!git) logger.warn('git-status: snapshot failed', { sessionId, workdir, baseBranch })
				return
			}

			const last = pluginCtx.lastSnapshots.get(sessionId)
			if (last && snapshotsEqual(last, snapshot)) return

			pluginCtx.lastSnapshots.set(sessionId, snapshot)
			notify('git_status_changed', {
				sessionId,
				committedAhead: snapshot.committedAhead,
				uncommittedFiles: snapshot.uncommittedFiles,
				lastCommitAt: snapshot.lastCommitAt,
				lastCommitMessage: snapshot.lastCommitMessage,
				updatedAt: Date.now(),
			})
		}

		const runTick = () => {
			tick().catch((err) => {
				if (isUnsupported(err)) {
					// Neither a git port nor a process table — no tick can ever succeed here.
					stop()
					logger.debug('git-status: disabled, host cannot run git', { sessionId, workdir })
					return
				}
				logger.warn('git-status tick failed', { sessionId, err: err instanceof Error ? err.message : String(err) })
			})
		}

		// Registered before the first tick so its failure handler can stop the timer.
		pluginCtx.intervals.set(sessionId, setInterval(runTick, POLL_INTERVAL_MS))
		runTick()
	})
	.sessionHook('onSessionClose', async (ctx) => {
		const sessionId = ctx.sessionId
		const pluginCtx = ctx.pluginContext
		pluginCtx.active = false
		const interval = pluginCtx.intervals.get(sessionId)
		if (interval) {
			clearInterval(interval)
			pluginCtx.intervals.delete(sessionId)
		}
		pluginCtx.lastSnapshots.delete(sessionId)
		pluginCtx.defaultBranches.delete(sessionId)
	})
	.build()

function snapshotsEqual(a: GitStatusSnapshot, b: GitStatusSnapshot): boolean {
	return a.committedAhead === b.committedAhead
		&& a.uncommittedFiles === b.uncommittedFiles
		&& a.lastCommitAt === b.lastCommitAt
		&& a.lastCommitMessage === b.lastCommitMessage
}

async function computeGitStatusOverPort(git: GitClient, workdir: string, baseBranch: string): Promise<GitStatusSnapshot | null> {
	try {
		const [committedAhead, entries, commits] = await Promise.all([
			git.countAhead({ dir: workdir, base: baseBranch }),
			git.status({ dir: workdir }),
			git.log({ dir: workdir, depth: 1 }),
		])

		const head = commits[0]
		return {
			committedAhead,
			uncommittedFiles: entries.length,
			lastCommitAt: head?.committedAt ?? null,
			// The shell path reads `%s`, the subject — so take the same first line here.
			lastCommitMessage: head ? subjectOf(head.message) : null,
		}
	} catch {
		return null
	}
}

async function detectDefaultBranchOverPort(git: GitClient, workdir: string): Promise<string | null> {
	try {
		return await git.defaultBranch({ dir: workdir }) ?? null
	} catch {
		return null
	}
}

async function computeGitStatus(process: ProcessRunner, workdir: string, baseBranch: string): Promise<GitStatusSnapshot | null> {
	const countOutput = await runGit(process, workdir, ['rev-list', '--count', `${baseBranch}..HEAD`])
	if (countOutput === null) return null
	const committedAhead = Number.parseInt(countOutput.trim(), 10)
	if (!Number.isFinite(committedAhead)) return null

	const statusOutput = await runGit(process, workdir, ['status', '--porcelain'])
	if (statusOutput === null) return null
	const uncommittedFiles = countNonEmptyLines(statusOutput)

	const logOutput = await runGit(process, workdir, ['log', '-1', '--format=%ct|%s', 'HEAD'])
	if (logOutput === null) return null

	let lastCommitAt: number | null = null
	let lastCommitMessage: string | null = null
	const trimmed = logOutput.trim()
	if (trimmed.length > 0) {
		const [tsRaw, ...rest] = trimmed.split('|')
		const ts = Number.parseInt(tsRaw ?? '', 10)
		if (Number.isFinite(ts)) lastCommitAt = ts * 1000
		lastCommitMessage = rest.join('|').trim() || null
	}

	return { committedAhead, uncommittedFiles, lastCommitAt, lastCommitMessage }
}

async function detectDefaultBranch(process: ProcessRunner, workdir: string): Promise<string | null> {
	const output = await runGit(process, workdir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
	if (output === null) return null
	const trimmed = output.trim()
	if (!trimmed.startsWith('origin/')) return null
	const branch = trimmed.slice('origin/'.length)
	return branch.length > 0 ? branch : null
}

async function runGit(process: ProcessRunner, workdir: string, args: string[]): Promise<string | null> {
	try {
		const { stdout } = await process.execFile('git', args, { cwd: workdir, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
		return stdout
	} catch (error) {
		// A failed git call is normal; a host that cannot spawn at all is not — let it out.
		if (isUnsupported(error)) throw error
		return null
	}
}

/** ENOSYS is what a ProcessRunner without a process table rejects with. */
function isUnsupported(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOSYS'
}

function subjectOf(message: string): string | null {
	return message.split('\n', 1)[0]?.trim() || null
}

function countNonEmptyLines(output: string): number {
	let count = 0
	for (const line of output.split('\n')) {
		if (line.length > 0) count += 1
	}
	return count
}
