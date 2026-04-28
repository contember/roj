/**
 * Git Status Plugin
 *
 * Polls git state (commits ahead of the default branch, uncommitted files,
 * last commit metadata) inside the session's workspace directory every few
 * seconds and emits a `git_status_changed` notification when the snapshot
 * changes. The worker DO persists the last snapshot into its session table so
 * versions sidebar and publish bars can render without reaching into the
 * sandbox on every page view.
 */

import z from 'zod/v4'
import { definePlugin } from '~/core/plugins/index.js'
import { sessionIdSchema } from '~/core/sessions/schema.js'
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
	}))
	.sessionHook('onSessionReady', async (ctx) => {
		const workdir = ctx.sessionState.workspaceDir
		if (!workdir) return

		const sessionId = ctx.sessionId
		const pluginCtx = ctx.pluginContext
		const processRunner = ctx.platform.process

		const tick = async () => {
			let baseBranch = pluginCtx.defaultBranches.get(sessionId)
			if (!baseBranch) {
				baseBranch = await detectDefaultBranch(processRunner, workdir) ?? DEFAULT_BRANCH_FALLBACK
				pluginCtx.defaultBranches.set(sessionId, baseBranch)
			}

			const snapshot = await computeGitStatus(processRunner, workdir, baseBranch)
			if (!snapshot) {
				ctx.logger.warn('git-status: snapshot failed', { sessionId, workdir, baseBranch })
				return
			}

			const last = pluginCtx.lastSnapshots.get(sessionId)
			if (last && snapshotsEqual(last, snapshot)) return

			pluginCtx.lastSnapshots.set(sessionId, snapshot)
			ctx.notify('git_status_changed', {
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
				ctx.logger.warn('git-status tick failed', { sessionId, err: err instanceof Error ? err.message : String(err) })
			})
		}

		runTick()
		const interval = setInterval(runTick, POLL_INTERVAL_MS)

		pluginCtx.intervals.set(sessionId, interval)
	})
	.sessionHook('onSessionClose', async (ctx) => {
		const sessionId = ctx.sessionId
		const pluginCtx = ctx.pluginContext
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
	} catch {
		return null
	}
}

function countNonEmptyLines(output: string): number {
	let count = 0
	for (const line of output.split('\n')) {
		if (line.length > 0) count += 1
	}
	return count
}
