import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { fullPlugins } from '~/bootstrap.js'
import { MemoryEventStore } from '~/core/events/memory.js'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { PluginNotification } from '~/core/plugins/plugin-builder.js'
import type { SessionManagerOptions } from '~/core/sessions/session-manager.js'
import { SessionManager } from '~/core/sessions/session-manager.js'
import type { Session } from '~/core/sessions/session.js'
import { ToolExecutor } from '~/core/tools/executor.js'
import { ToolCallId } from '~/core/tools/schema.js'
import type { Logger } from '~/lib/logger/logger.js'
import { silentLogger } from '~/lib/logger/logger.js'
import { sleep } from '~/lib/utils/sleep.js'
import type { FsRevision, GitClient, GitStatusEntry, Platform, ProcessRunner, Scheduler } from '~/platform/index.js'
import { createNodePlatform, createNodeProcessRunner } from '~/testing/node-platform.js'
import { createTestPreset } from '~/testing/preset-helpers.js'
import { waitForAllAgentsIdle } from '~/testing/wait-helpers.js'
import z from 'zod/v4'
import { gitStatusPlugin } from './plugin.js'

/** Mirrors the plugin's own poll interval — the suite cannot import it. */
const POLL_INTERVAL_MS = 2000

/** Long enough to outlast the awaits of a read that never had to touch a disk. */
const SETTLE_MS = 300

const COMMIT_SECONDS = 1_700_000_000

const notificationSchema = z.object({
	sessionId: z.string(),
	committedAhead: z.number(),
	uncommittedFiles: z.number(),
	lastCommitAt: z.number().nullable(),
	lastCommitMessage: z.string().nullable(),
	updatedAt: z.number(),
})

const refreshSchema = z.object({
	snapshot: z.object({
		committedAhead: z.number(),
		uncommittedFiles: z.number(),
		lastCommitAt: z.number().nullable(),
		lastCommitMessage: z.string().nullable(),
	}).nullable(),
})

type GitStatusNotification = z.infer<typeof notificationSchema>

const scratch = (prefix: string) => join(tmpdir(), `roj-git-status-${prefix}-${Math.random().toString(36).slice(2)}`)

function recordingLogger(warnings: string[]): Logger {
	const logger: Logger = {
		debug: () => {},
		info: () => {},
		warn: (message) => {
			warnings.push(message)
		},
		error: () => {},
		child: () => logger,
		level: 'debug',
	}
	return logger
}

/** A repo with one commit ahead of main, one modified file and one untracked file. */
function fakeGitClient(overrides: Partial<GitClient> = {}): GitClient {
	return {
		status: async () => [
			{ path: 'note.txt', index: ' ', worktree: 'M' },
			{ path: 'scratch.txt', index: ' ', worktree: '?' },
		],
		log: async () => [{ oid: 'abc123', message: 'second\n\nbody paragraph\n', committedAt: COMMIT_SECONDS * 1000 }],
		countAhead: async () => 1,
		defaultBranch: async () => undefined,
		...overrides,
	}
}

/** Counts the call the revision gate exists to skip. */
function countingGitClient(overrides: Partial<GitClient> = {}): { client: GitClient; reads: () => number } {
	let reads = 0
	const base = fakeGitClient(overrides)
	return {
		client: {
			...base,
			status: (options) => {
				reads += 1
				return base.status(options)
			},
		},
		reads: () => reads,
	}
}

/**
 * The shape of an evictable host: wakes are armed here and delivered by whatever
 * process is alive when they come due, so nothing fires on its own.
 */
class RecordingScheduler implements Scheduler {
	readonly armed = new Map<string, number>()

	async wake(key: string, delayMs: number): Promise<void> {
		this.armed.set(key, delayMs)
	}

	async cancel(key: string): Promise<void> {
		this.armed.delete(key)
	}
}

// ============================================================================
// Booting a session around the plugin
// ============================================================================

interface Booted {
	manager: SessionManager
	session: Session
	notifications: PluginNotification[]
}

const cleanups: Array<() => Promise<void>> = []

async function bootSession(options: {
	platform: Platform
	workspaceDir?: string
	logger?: Logger
	systemPlugins?: SessionManagerOptions['systemPlugins']
	llmProvider?: MockLLMProvider
}): Promise<Booted> {
	const notifications: PluginNotification[] = []
	const basePath = scratch('base')
	const logger = options.logger ?? silentLogger
	const preset = createTestPreset({ id: 'git-status-test', workspaceDir: options.workspaceDir ?? scratch('workspace') })

	const manager = new SessionManager({
		eventStore: new MemoryEventStore(),
		llmProvider: options.llmProvider ?? MockLLMProvider.withFixedResponse({ content: 'ok', toolCalls: [] }),
		toolExecutor: new ToolExecutor(logger),
		presets: new Map([[preset.id, preset]]),
		logger,
		basePath,
		dataFileStore: new SessionFileStore(basePath, undefined, false, options.platform.fs, 'session'),
		onUserOutput: (notification) => notifications.push(notification),
		platform: options.platform,
		systemPlugins: options.systemPlugins ?? [gitStatusPlugin],
	})
	cleanups.push(async () => {
		await manager.shutdown()
		await rm(basePath, { recursive: true, force: true })
	})

	const created = await manager.createSession(preset.id)
	if (!created.ok) throw new Error(`createSession failed: ${created.error.message}`)
	return { manager, session: created.value, notifications }
}

/**
 * Play the host that delivers wakes, until nothing is armed any more.
 *
 * Nothing runs on its own under a {@link RecordingScheduler} — the agent loop
 * re-enters through the same port — so a turn only advances one hop per round.
 */
async function settle(booted: Booted, scheduler: RecordingScheduler, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	let quiet = 0
	while (Date.now() < deadline) {
		const keys = [...scheduler.armed.keys()]
		if (keys.length === 0) {
			if (++quiet >= 3) return
		} else {
			quiet = 0
			scheduler.armed.clear()
			for (const key of keys) await booted.manager.dispatchWake(key)
		}
		await sleep(20)
	}
	throw new Error('scheduler wakes never settled')
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup()
})

function seen(notifications: readonly PluginNotification[]): GitStatusNotification[] {
	return notifications
		.filter((entry) => entry.pluginName === 'git-status' && entry.type === 'git_status_changed')
		.map((entry) => notificationSchema.parse(entry.payload))
}

/** The notified snapshots, stripped of the two fields no two sessions can share. */
function reported(notifications: readonly PluginNotification[]) {
	return seen(notifications).map(({ sessionId, updatedAt, ...snapshot }) => snapshot)
}

async function pull(session: Session): Promise<z.infer<typeof refreshSchema>> {
	const result = await session.callPluginMethod('git-status.refresh', {})
	if (!result.ok) throw new Error(`refresh failed: ${result.error.message}`)
	return refreshSchema.parse(result.value)
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await sleep(20)
	}
	throw new Error(`condition not met within ${timeoutMs}ms`)
}

// ============================================================================
// The two ways to read a repository
// ============================================================================

const gitRunner = createNodeProcessRunner()

/** `git` over the port's shapes, so the two read paths can be compared on one repo. */
function realGitClient(runner: ProcessRunner): GitClient {
	const run = async (dir: string, args: string[]): Promise<string> => (await runner.execFile('git', args, { cwd: dir })).stdout

	return {
		async status({ dir }) {
			const output = await run(dir, ['status', '--porcelain'])
			return output
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => ({ path: line.slice(3), index: indexCode(line[0]), worktree: worktreeCode(line[1]) }))
		},

		async log({ dir, ref, depth }) {
			const format = '--format=%H%x1f%ct%x1f%B%x1e'
			const output = await run(dir, ['log', ...(depth === undefined ? [] : ['-n', String(depth)]), format, ref ?? 'HEAD'])
			return output
				.split('\x1e')
				.map((chunk) => chunk.trim())
				.filter((chunk) => chunk.length > 0)
				.map((chunk) => {
					const [oid = '', committedAt = '', message = ''] = chunk.split('\x1f')
					return { oid, message, committedAt: Number.parseInt(committedAt, 10) * 1000 }
				})
		},

		async countAhead({ dir, base, ref }) {
			return Number.parseInt((await run(dir, ['rev-list', '--count', `${base}..${ref ?? 'HEAD'}`])).trim(), 10)
		},

		async defaultBranch({ dir }) {
			try {
				const output = (await run(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
				return output.startsWith('origin/') ? output.slice('origin/'.length) : undefined
			} catch {
				return undefined
			}
		},
	}
}

function indexCode(char: string | undefined): GitStatusEntry['index'] {
	return char === 'A' || char === 'M' || char === 'D' ? char : ' '
}

function worktreeCode(char: string | undefined): GitStatusEntry['worktree'] {
	return char === 'A' || char === 'M' || char === 'D' || char === '?' ? char : ' '
}

/** One commit ahead of `main`, one modified tracked file, one untracked file. */
async function makeRepo(): Promise<{ dir: string; lastCommitAt: number }> {
	const dir = scratch('repo')
	await mkdir(dir, { recursive: true })
	cleanups.push(() => rm(dir, { recursive: true, force: true }))

	const identity = ['-c', 'user.email=test@roj.local', '-c', 'user.name=Roj Test', '-c', 'commit.gpgsign=false']
	const run = (...args: string[]) => gitRunner.execFile('git', [...identity, ...args], { cwd: dir })

	await run('init', '-q', '-b', 'main')
	await writeFile(join(dir, 'note.txt'), 'one\n')
	await run('add', 'note.txt')
	await run('commit', '-q', '-m', 'first')
	await run('checkout', '-q', '-b', 'feature')
	await writeFile(join(dir, 'note.txt'), 'two\n')
	await run('commit', '-q', '-a', '-m', 'second')
	await writeFile(join(dir, 'note.txt'), 'three\n')
	await writeFile(join(dir, 'scratch.txt'), 'scratch\n')

	const { stdout } = await run('log', '-1', '--format=%ct', 'HEAD')
	return { dir, lastCommitAt: Number.parseInt(stdout.trim(), 10) * 1000 }
}

describe('git-status reads a repository through the port or the binary', () => {
	test('both paths answer the same for the same repo', async () => {
		const repo = await makeRepo()
		const base: Platform = { ...createNodePlatform(), scheduler: new RecordingScheduler() }

		const overPort = await bootSession({ platform: { ...base, git: realGitClient(gitRunner) }, workspaceDir: repo.dir })
		const overBinary = await bootSession({ platform: base, workspaceDir: repo.dir })

		const fromPort = await pull(overPort.session)
		const fromBinary = await pull(overBinary.session)

		expect(fromPort.snapshot).toEqual({
			committedAhead: 1,
			uncommittedFiles: 2,
			lastCommitAt: repo.lastCommitAt,
			lastCommitMessage: 'second',
		})
		expect(fromBinary.snapshot).toEqual(fromPort.snapshot)
		expect(reported(overPort.notifications)).toEqual(reported(overBinary.notifications))
	})

	test('a workspace with no repository yields no snapshot on either path', async () => {
		const warnings: string[] = []
		const base: Platform = { ...createNodePlatform(), scheduler: new RecordingScheduler() }
		const empty = scratch('empty')

		const overPort = await bootSession({ platform: { ...base, git: realGitClient(gitRunner) }, workspaceDir: empty, logger: recordingLogger(warnings) })
		const overBinary = await bootSession({ platform: base, workspaceDir: empty, logger: recordingLogger(warnings) })

		expect((await pull(overPort.session)).snapshot).toBeNull()
		expect((await pull(overBinary.session)).snapshot).toBeNull()
		expect(seen(overPort.notifications)).toEqual([])
		expect(seen(overBinary.notifications)).toEqual([])
	})
})

describe('git-status gated on the host filesystem revision', () => {
	const gatedPlatform = (git: GitClient, fsRevision?: FsRevision): Platform => ({
		...createNodePlatform(),
		git,
		fsRevision,
		scheduler: new RecordingScheduler(),
	})

	test('replays the last answer while the revision stands still', async () => {
		const git = countingGitClient()
		const { session } = await bootSession({ platform: gatedPlatform(git.client, { current: async () => 7 }) })

		const first = await pull(session)
		const second = await pull(session)

		expect(git.reads()).toBe(1)
		expect(second).toEqual(first)
	})

	test('reads again once the revision moves', async () => {
		let revision = 1
		let committedAhead = 1
		const git = countingGitClient({ countAhead: async () => committedAhead })
		const { session, notifications } = await bootSession({
			platform: gatedPlatform(git.client, { current: async () => revision }),
		})

		await pull(session)
		committedAhead = 5
		revision = 2
		const second = await pull(session)

		expect(git.reads()).toBe(2)
		expect(second.snapshot?.committedAhead).toBe(5)
		expect(seen(notifications).map((n) => n.committedAhead)).toEqual([1, 5])
	})

	test('reads every time on a host with no fsRevision port', async () => {
		const git = countingGitClient()
		const { session } = await bootSession({ platform: gatedPlatform(git.client) })

		await pull(session)
		await pull(session)

		expect(git.reads()).toBe(2)
	})

	test('reads every time where the host cannot answer, or answers badly', async () => {
		const warnings: string[] = []
		const unknown: FsRevision = { current: async () => undefined }
		const broken: FsRevision = { current: () => Promise.reject(new Error('no such table: vfs_meta')) }

		const git = countingGitClient()
		for (const fsRevision of [unknown, broken]) {
			const { session } = await bootSession({ platform: gatedPlatform(git.client, fsRevision), logger: recordingLogger(warnings) })
			await pull(session)
			await pull(session)
		}

		// Two hosts, two pulls each, and not one of them gated.
		expect(git.reads()).toBe(4)
		expect(warnings).toEqual([])
	})
})

describe('git-status only keeps a clock where the host has one', () => {
	test('polls under a scheduler that delivers its own wakes', async () => {
		let committedAhead = 1
		const platform: Platform = { ...createNodePlatform(), git: fakeGitClient({ countAhead: async () => committedAhead }) }
		const { notifications } = await bootSession({ platform })

		await waitUntil(() => seen(notifications).length === 1, SETTLE_MS * 4)
		committedAhead = 4
		await waitUntil(() => seen(notifications).length === 2, POLL_INTERVAL_MS * 2)

		expect(seen(notifications).map((n) => n.committedAhead)).toEqual([1, 4])
	})

	test('arms nothing under a scheduler that does not', async () => {
		const scheduler = new RecordingScheduler()
		const platform: Platform = { ...createNodePlatform(), git: fakeGitClient(), scheduler }
		const booted = await bootSession({ platform })
		await settle(booted, scheduler)

		// Well past a poll period: on a live host this is where the first two ticks landed.
		await sleep(POLL_INTERVAL_MS + SETTLE_MS)

		// Nothing fired, and nothing is waiting to: an idle session holds no clock here.
		expect(seen(booted.notifications)).toEqual([])
		expect([...scheduler.armed.keys()]).toEqual([])
	})

	test('refreshes at the turn boundary that follows a tool call instead', async () => {
		const scheduler = new RecordingScheduler()
		// Only a read taken after the tool call can see this move.
		let committedAhead = 0
		const platform: Platform = { ...createNodePlatform(), git: fakeGitClient({ countAhead: async () => committedAhead }), scheduler }
		const booted = await bootSession({
			platform,
			systemPlugins: fullPlugins,
			llmProvider: MockLLMProvider.withSequence([
				{ toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'working' } }] },
				{ content: 'done', toolCalls: [] },
			]),
		})
		const { session, notifications } = booted
		await settle(booted, scheduler)

		expect(seen(notifications)).toEqual([])
		committedAhead = 3

		const entryAgentId = session.getEntryAgentId()
		if (!entryAgentId) throw new Error('no entry agent')
		const sent = await session.callPluginMethod('user-chat.sendMessage', {
			sessionId: String(session.id),
			content: 'go',
			agentId: String(entryAgentId),
		})
		expect(sent.ok).toBe(true)
		await settle(booted, scheduler)
		await waitForAllAgentsIdle(session)

		expect(seen(notifications).map((n) => n.committedAhead)).toEqual([3])
		// The turn is over: a refresh must not have left a wake of its own behind.
		expect([...scheduler.armed.keys()]).toEqual([])
	}, 20_000)

	test('a client pull answers, and notifies only once per change', async () => {
		const platform: Platform = { ...createNodePlatform(), git: fakeGitClient(), scheduler: new RecordingScheduler() }
		const { session, notifications } = await bootSession({ platform })

		const pulled = await pull(session)
		expect(pulled.snapshot).toEqual({
			committedAhead: 1,
			uncommittedFiles: 2,
			lastCommitAt: COMMIT_SECONDS * 1000,
			lastCommitMessage: 'second',
		})

		// An unchanged snapshot is not news; the client already has this one.
		await pull(session)
		expect(seen(notifications)).toHaveLength(1)
	})
})
