/**
 * Git Status Plugin
 *
 * Reports the git state of a session's workspace — commits ahead of the default
 * branch, uncommitted files, last commit metadata — as a `git_status_changed`
 * notification whenever the snapshot moves. The worker DO persists the last one
 * into its session table so versions sidebars and publish bars render without
 * reaching into the sandbox on every page view.
 *
 * Two ways to read that state. `platform.git` answers it directly, which is how
 * hosts with no process table (a Worker isolate over a VFS) take part; without
 * the port the plugin shells out to the `git` binary, as it always has.
 *
 * *When* it reads is a host question, because who may write the workspace is.
 * Where the process outlives a wake — `platform.scheduler` delivers its own —
 * roj is not the only writer: the user has the directory open in an editor, and
 * `services` runs dev servers inside it. Nothing but a clock sees those, so one
 * still runs there, at the 2 s it always has.
 *
 * A host that is evicted between wakes has no such writer: every byte arrives
 * through a tool call or an inbound request. And there a clock is ruinous — in
 * workerd every armed timer registers a wait-until task that `drain()` waits on,
 * and a repeating one arms a fresh task per tick, so one live session is enough
 * to keep the actor from ever going idle. So on those hosts the plugin arms
 * nothing at all: it refreshes at the turn boundary that follows a tool call,
 * and otherwise answers `git-status.refresh` when a client pulls.
 *
 * Pulls are the one caller nothing rate-limits — every open tab asks — so where
 * `platform.fsRevision` exists the answer in hand is reused while that counter
 * stands still. The counter covers the whole host filesystem, not this workspace,
 * so a write in a neighbouring session costs this one a recomputation it did not
 * need; the trade only ever errs that way, which is the only direction a cache
 * over a working tree may err.
 */

import { definePlugin } from '~/core/plugins/index.js'
import type { SessionId } from '~/core/sessions/schema.js'
import { sessionIdSchema } from '~/core/sessions/schema.js'
import type { Logger } from '~/lib/logger/logger.js'
import { Ok } from '~/lib/utils/result.js'
import type { FsRevision } from '~/platform/fs-revision.js'
import type { GitClient } from '~/platform/git.js'
import type { ProcessRunner } from '~/platform/process.js'
import { isLiveScheduler } from '~/platform/scheduler.js'
import z from 'zod/v4'

const POLL_INTERVAL_MS = 2000
const GIT_TIMEOUT_MS = 5000
const DEFAULT_BRANCH_FALLBACK = 'main'

const gitStatusSnapshotSchema = z.object({
	committedAhead: z.number(),
	uncommittedFiles: z.number(),
	lastCommitAt: z.number().nullable(),
	lastCommitMessage: z.string().nullable(),
})

const gitStatusChangedSchema = z.object({
	sessionId: sessionIdSchema,
	...gitStatusSnapshotSchema.shape,
	updatedAt: z.number(),
})

type GitStatusSnapshot = z.infer<typeof gitStatusSnapshotSchema>
type GitStatusChanged = z.infer<typeof gitStatusChangedSchema>

interface SessionGitStatus {
	/** Whether this host has a clock of its own; false means nothing may be armed. */
	polls: boolean
	/** The 2 s interval, on polling hosts only. */
	interval?: NodeJS.Timeout
	lastSnapshot?: GitStatusSnapshot
	/**
	 * What the last completed read answered, and the filesystem revision it read
	 * at. Replayed verbatim while that revision stands still — including the null
	 * a workspace with no repository yields, since a still filesystem cannot have
	 * grown one. Absent on hosts that report no revision, which never gate.
	 */
	gated?: { revision: number; snapshot: GitStatusSnapshot | null }
	defaultBranch?: string
	/** A tool wrote in this workspace since the last read. */
	touched: boolean
	/** Neither a git port nor a process table — no read can ever succeed here. */
	unsupported: boolean
	/** Shared by overlapping callers, so one turn boundary costs one git read. */
	inFlight?: Promise<GitStatusSnapshot | null>
}

interface GitStatusPluginContext {
	sessions: Map<string, SessionGitStatus>
}

/**
 * The slice of a hook or method context a read needs. Session hooks, agent hooks
 * and method handlers all satisfy it, so all three share one code path.
 */
interface GitStatusCallContext {
	sessionId: SessionId
	sessionState: { workspaceDir?: string }
	platform: { git?: GitClient; process: ProcessRunner; fsRevision?: FsRevision }
	logger: Logger
	notify: (type: 'git_status_changed', payload: GitStatusChanged) => void
	pluginContext: GitStatusPluginContext
}

export const gitStatusPlugin = definePlugin('git-status')
	.notification('git_status_changed', { schema: gitStatusChangedSchema })
	.context(async (): Promise<GitStatusPluginContext> => ({ sessions: new Map() }))
	.method('refresh', {
		input: z.object({ sessionId: sessionIdSchema }),
		output: z.object({ snapshot: gitStatusSnapshotSchema.nullable() }),
		// The pull half of the contract: a client that just wrote, or just opened the
		// session, asks for the snapshot instead of waiting for a poll to notice.
		handler: async (ctx) => Ok({ snapshot: await refresh(ctx) }),
	})
	.sessionHook('onSessionReady', async (ctx) => {
		const workdir = ctx.sessionState.workspaceDir
		if (!workdir) return

		const polls = isLiveScheduler(ctx.platform.scheduler)
		const entry: SessionGitStatus = { polls, touched: false, unsupported: false }
		ctx.pluginContext.sessions.set(ctx.sessionId, entry)
		if (!polls) return

		// Armed before the first read, so an ENOSYS read can stop the timer it is in.
		entry.interval = setInterval(() => void refresh(ctx), POLL_INTERVAL_MS)
		void refresh(ctx)
	})
	.hook('afterToolCall', async (ctx) => {
		// Cheap: the read itself waits for the turn to end, and is skipped if no tool ran.
		const entry = ctx.pluginContext.sessions.get(ctx.sessionId)
		if (entry) entry.touched = true
		return null
	})
	.hook('onComplete', async (ctx) => {
		const entry = ctx.pluginContext.sessions.get(ctx.sessionId)
		// On a polling host the clock already covers this; elsewhere the turn boundary
		// is the one moment the workspace demonstrably changed and nothing is armed.
		if (!entry || entry.polls || !entry.touched) return null
		entry.touched = false
		await refresh(ctx)
		return null
	})
	.sessionHook('onSessionClose', async (ctx) => {
		const entry = ctx.pluginContext.sessions.get(ctx.sessionId)
		if (entry?.interval) clearInterval(entry.interval)
		ctx.pluginContext.sessions.delete(ctx.sessionId)
	})
	.build()

/** Read the workspace's git state, notifying if it moved. Never rejects. */
async function refresh(ctx: GitStatusCallContext): Promise<GitStatusSnapshot | null> {
	const entry = ctx.pluginContext.sessions.get(ctx.sessionId)
	if (!entry || entry.unsupported) return null

	const existing = entry.inFlight
	if (existing) return existing

	const run = readSnapshot(ctx, entry).finally(() => {
		if (entry.inFlight === run) entry.inFlight = undefined
	})
	entry.inFlight = run
	return run
}

async function readSnapshot(ctx: GitStatusCallContext, entry: SessionGitStatus): Promise<GitStatusSnapshot | null> {
	const sessionId = ctx.sessionId
	const workdir = ctx.sessionState.workspaceDir
	if (!workdir) return null
	const git = ctx.platform.git
	const processRunner = ctx.platform.process

	try {
		// Read before the git calls, never after: a write that lands while they run
		// belongs to the next answer, and stamping the revision they produced would
		// bury it. Same reason the value is stamped only once a read completes.
		const revision = await currentRevision(ctx)
		const gated = entry.gated
		if (revision !== undefined && gated?.revision === revision) return gated.snapshot

		let baseBranch = entry.defaultBranch
		if (!baseBranch) {
			const detected = git
				? await detectDefaultBranchOverPort(git, workdir)
				: await detectDefaultBranch(processRunner, workdir)
			baseBranch = detected ?? DEFAULT_BRANCH_FALLBACK
			entry.defaultBranch = baseBranch
		}

		const snapshot = git
			? await computeGitStatusOverPort(git, workdir, baseBranch)
			: await computeGitStatus(processRunner, workdir, baseBranch)
		if (!snapshot) {
			// A workspace with no repository is an ordinary state the port reports
			// cheaply; only the shell-out path, where a failure means the binary
			// itself misbehaved, is worth a warning.
			if (!git) ctx.logger.warn('git-status: snapshot failed', { sessionId, workdir, baseBranch })
			entry.gated = revision === undefined ? undefined : { revision, snapshot: null }
			return null
		}

		// The runtime may have begun unloading during the reads above — onSessionClose
		// drops the entry — and a notification then lands on nobody.
		if (ctx.pluginContext.sessions.get(sessionId) !== entry) return null

		const last = entry.lastSnapshot
		entry.lastSnapshot = snapshot
		entry.gated = revision === undefined ? undefined : { revision, snapshot }
		if (!last || !snapshotsEqual(last, snapshot)) {
			ctx.notify('git_status_changed', { sessionId, ...snapshot, updatedAt: Date.now() })
		}
		return snapshot
	} catch (err) {
		if (isUnsupported(err)) {
			// Neither a git port nor a process table — no read can ever succeed here.
			entry.unsupported = true
			if (entry.interval) clearInterval(entry.interval)
			entry.interval = undefined
			ctx.logger.debug('git-status: disabled, host cannot run git', { sessionId, workdir })
			return null
		}
		ctx.logger.warn('git-status refresh failed', { sessionId, err: err instanceof Error ? err.message : String(err) })
		return null
	}
}

/**
 * The host's filesystem revision, or `undefined` when there is none to read.
 *
 * Defensive beyond the port's contract on purpose: this is an optimisation, and
 * a host that answers badly must lose the optimisation, not the feature.
 */
async function currentRevision(ctx: GitStatusCallContext): Promise<number | undefined> {
	try {
		return await ctx.platform.fsRevision?.current()
	} catch {
		return undefined
	}
}

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
