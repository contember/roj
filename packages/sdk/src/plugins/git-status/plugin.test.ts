import { afterEach, describe, expect, test } from 'bun:test'
import { MemoryEventStore } from '~/core/events/memory.js'
import { SessionFileStore } from '~/core/file-store/file-store.js'
import { MockLLMProvider } from '~/core/llm/mock.js'
import type { PluginNotification } from '~/core/plugins/plugin-builder.js'
import { SessionManager } from '~/core/sessions/session-manager.js'
import type { Session } from '~/core/sessions/session.js'
import { ToolExecutor } from '~/core/tools/executor.js'
import { ToolCallId } from '~/core/tools/schema.js'
import type { Logger } from '~/lib/logger/logger.js'
import type { ExecFileResult, FsRevision, GitClient, Platform, ProcessRunner, Scheduler } from '~/platform/index.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { createTestPreset } from '~/testing/preset-helpers.js'
import { TestHarness } from '~/testing/test-harness.js'
import { gitStatusPlugin } from './plugin.js'

const COMMIT_SECONDS = 1_700_000_000

/** The first read runs at session ready; this only has to outlast its awaits. */
const SETTLE_MS = 300

/** Mirrors the plugin's own poll interval — the suite cannot import it. */
const POLL_INTERVAL_MS = 2000

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

/** A repo with one commit, one modified file and one untracked file. */
function fakeGitClient(overrides: Partial<GitClient> = {}): GitClient {
	return {
		status: async () => [
			{ path: 'note.txt', index: ' ', worktree: 'M' },
			{ path: 'scratch.txt', index: ' ', worktree: '?' },
		],
		log: async () => [{ oid: 'abc123', message: 'add note\n\nbody paragraph\n', committedAt: COMMIT_SECONDS * 1000 }],
		countAhead: async () => 2,
		defaultBranch: async () => undefined,
		...overrides,
	}
}

/** ProcessRunner answering the exact `git` calls the shell-out path makes, same repo. */
function fakeGitProcessRunner(): ProcessRunner {
	return {
		execFile: async (file, args): Promise<ExecFileResult> => {
			if (file !== 'git') throw new Error(`unexpected command ${file}`)
			if (args[0] === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' }
			if (args[0] === 'rev-list') return { stdout: '2\n', stderr: '' }
			if (args[0] === 'status') return { stdout: ' M note.txt\n?? scratch.txt\n', stderr: '' }
			if (args[0] === 'log') return { stdout: `${COMMIT_SECONDS}|add note\n`, stderr: '' }
			throw new Error(`unexpected git ${args[0]}`)
		},
		spawn: () => {
			throw new Error('spawn is not used by git-status')
		},
	}
}

/** What an isolate without a shell backend hands the SDK — `execFile` always ENOSYS. */
function enosysProcessRunner(): ProcessRunner {
	const fail = () => Object.assign(new Error('no process table'), { code: 'ENOSYS' })
	return {
		execFile: () => Promise.reject(fail()),
		spawn: () => {
			throw fail()
		},
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

const managers: SessionManager[] = []

/** Boot a session with only `git-status` registered, collecting its notifications. */
async function bootSession(platform: Platform, logger: Logger): Promise<{ session: Session; notifications: PluginNotification[] }> {
	const notifications: PluginNotification[] = []
	const basePath = `/tmp/roj-git-status-${Math.random().toString(36).slice(2)}`
	// The session really creates its workspace, so it has to be somewhere writable.
	const preset = createTestPreset({ id: 'git-status-test', workspaceDir: `${basePath}/workspace` })

	const manager = new SessionManager({
		eventStore: new MemoryEventStore(),
		llmProvider: MockLLMProvider.withFixedResponse({ content: 'ok', toolCalls: [] }),
		toolExecutor: new ToolExecutor(logger),
		presets: new Map([[preset.id, preset]]),
		logger,
		basePath,
		dataFileStore: new SessionFileStore(basePath, undefined, false, platform.fs, 'session'),
		onUserOutput: (notification) => notifications.push(notification),
		platform,
		systemPlugins: [gitStatusPlugin],
	})
	managers.push(manager)

	const created = await manager.createSession(preset.id)
	if (!created.ok) throw new Error(`createSession failed: ${created.error.message}`)

	return { session: created.value, notifications }
}

function snapshotOf(notifications: readonly PluginNotification[]): unknown | null {
	return notifications.find((entry) => entry.type === 'git_status_changed')?.payload ?? null
}

/** Boot a session and return the snapshot its poll produced, if any. */
async function firstSnapshot(platform: Platform, logger: Logger, settleMs = SETTLE_MS): Promise<unknown | null> {
	const { notifications } = await bootSession(platform, logger)
	await Bun.sleep(settleMs)
	return snapshotOf(notifications)
}

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.shutdown()
})

describe('git-status on a host with a live process', () => {
	test('reads the snapshot off platform.git when the host has one', async () => {
		const platform: Platform = { ...createNodePlatform(), process: enosysProcessRunner(), git: fakeGitClient() }

		expect(await firstSnapshot(platform, recordingLogger([]))).toMatchObject({
			committedAhead: 2,
			uncommittedFiles: 2,
			lastCommitAt: COMMIT_SECONDS * 1000,
			// Subject line only, matching what `--format=%s` yields on the shell path.
			lastCommitMessage: 'add note',
		})
	})

	test('produces the same snapshot over execFile when there is no git port', async () => {
		const platform: Platform = { ...createNodePlatform(), process: fakeGitProcessRunner() }

		expect(await firstSnapshot(platform, recordingLogger([]))).toMatchObject({
			committedAhead: 2,
			uncommittedFiles: 2,
			lastCommitAt: COMMIT_SECONDS * 1000,
			lastCommitMessage: 'add note',
		})
	})

	test('stays quiet when the git port reports no repository', async () => {
		const warnings: string[] = []
		const rejects = () => Promise.reject(new Error('NotARepositoryError'))
		const platform: Platform = {
			...createNodePlatform(),
			process: enosysProcessRunner(),
			git: fakeGitClient({ status: rejects, log: rejects, countAhead: rejects, defaultBranch: rejects }),
		}

		expect(await firstSnapshot(platform, recordingLogger(warnings))).toBeNull()
		expect(warnings).toEqual([])
	})

	test('never warns on a host with neither a git port nor a process table', async () => {
		const warnings: string[] = []
		const platform: Platform = { ...createNodePlatform(), process: enosysProcessRunner() }

		// Past one poll interval: without the ENOSYS stop this warns on every tick.
		expect(await firstSnapshot(platform, recordingLogger(warnings), POLL_INTERVAL_MS + SETTLE_MS)).toBeNull()
		expect(warnings).toEqual([])
	})
})

describe('git-status on a host that is evicted between wakes', () => {
	const evictablePlatform = (git: GitClient): Platform => ({
		...createNodePlatform(),
		process: enosysProcessRunner(),
		git,
		scheduler: new RecordingScheduler(),
	})

	test('arms nothing, so an idle session holds no timer', async () => {
		const { notifications } = await bootSession(evictablePlatform(fakeGitClient()), recordingLogger([]))

		// Well past a poll period: on a live host this is where the first tick landed.
		await Bun.sleep(POLL_INTERVAL_MS + SETTLE_MS)
		expect(snapshotOf(notifications)).toBeNull()
	})

	test('answers a pull with the snapshot, and notifies once per change', async () => {
		const { session, notifications } = await bootSession(evictablePlatform(fakeGitClient()), recordingLogger([]))

		const pulled = await session.callPluginMethod('git-status.refresh', { sessionId: String(session.id) })
		expect(pulled.ok).toBe(true)
		if (!pulled.ok) return
		expect(pulled.value).toEqual({
			snapshot: { committedAhead: 2, uncommittedFiles: 2, lastCommitAt: COMMIT_SECONDS * 1000, lastCommitMessage: 'add note' },
		})
		expect(snapshotOf(notifications)).toMatchObject({ committedAhead: 2, uncommittedFiles: 2 })

		// An unchanged snapshot is not news; the client already has this one.
		await session.callPluginMethod('git-status.refresh', { sessionId: String(session.id) })
		expect(notifications.filter((entry) => entry.type === 'git_status_changed')).toHaveLength(1)
	})

	test('refreshes at the turn boundary that follows a tool call', async () => {
		const scheduler = new RecordingScheduler()
		// Only a second read can see this move, so a notification proves one happened.
		let committedAhead = 0
		const platform: Platform = {
			...createNodePlatform(),
			process: enosysProcessRunner(),
			git: fakeGitClient({ countAhead: async () => committedAhead }),
			scheduler,
		}

		const workspaceDir = `/tmp/roj-git-status-turn-${Math.random().toString(36).slice(2)}/workspace`
		const harness = new TestHarness({
			presets: [createTestPreset({ workspaceDir })],
			platform,
			llmProvider: MockLLMProvider.withSequence([
				{ content: null, toolCalls: [{ id: ToolCallId('tc1'), name: 'tell_user', input: { message: 'working' } }] },
				{ content: 'done', toolCalls: [] },
			]),
		})

		try {
			const session = await harness.createSession('test')
			await session.sendMessage('go')
			committedAhead = 3

			// Nothing runs on its own here: each hop is a wake this test delivers.
			for (let hop = 0; hop < 10 && scheduler.armed.size > 0; hop++) {
				const keys = [...scheduler.armed.keys()]
				scheduler.armed.clear()
				for (const key of keys) await harness.sessionManager.dispatchWake(key)
			}

			const notified = harness.notifications.getByType('git-status', 'git_status_changed')
			expect(notified).toHaveLength(1)
			expect(notified[0]?.payload).toMatchObject({ committedAhead: 3 })
			// The turn is over and the loop is done — a refresh must not have re-armed anything.
			expect([...scheduler.armed.keys()]).toEqual([])
		} finally {
			await harness.shutdown()
		}
	})
})

describe('git-status gated on the host filesystem revision', () => {
	/** `status` is the call the gate exists to skip, so count it. */
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

	const gatedPlatform = (git: GitClient, fsRevision?: FsRevision): Platform => ({
		...createNodePlatform(),
		process: enosysProcessRunner(),
		git,
		fsRevision,
		scheduler: new RecordingScheduler(),
	})

	const pull = (session: Session) => session.callPluginMethod('git-status.refresh', { sessionId: String(session.id) })

	/** A host with the counter but no delta — every recomputation is a full read. */
	const noDelta = { changedSince: async (): Promise<undefined> => undefined }

	test('replays the last answer while the revision stands still', async () => {
		const git = countingGitClient()
		const { session } = await bootSession(gatedPlatform(git.client, { ...noDelta, current: async () => 7 }), recordingLogger([]))

		const first = await pull(session)
		const second = await pull(session)
		expect(git.reads()).toBe(1)
		expect(second).toEqual(first)
	})

	test('reads again once the revision moves', async () => {
		let revision = 1
		let committedAhead = 2
		const git = countingGitClient({ countAhead: async () => committedAhead })
		const { session, notifications } = await bootSession(
			gatedPlatform(git.client, { ...noDelta, current: async () => revision }),
			recordingLogger([]),
		)

		await pull(session)
		committedAhead = 5
		revision = 2
		await pull(session)

		expect(git.reads()).toBe(2)
		const changes = notifications.filter((entry) => entry.type === 'git_status_changed')
		expect(changes).toHaveLength(2)
		expect(changes[1]?.payload).toMatchObject({ committedAhead: 5 })
	})

	test('reads on every pull where the host reports no revision', async () => {
		const git = countingGitClient()
		const { session } = await bootSession(gatedPlatform(git.client), recordingLogger([]))

		await pull(session)
		await pull(session)
		expect(git.reads()).toBe(2)
	})

	test('reads on every pull where the host answers badly', async () => {
		const warnings: string[] = []
		const git = countingGitClient()
		const unknown: FsRevision = { ...noDelta, current: async () => undefined }
		const broken: FsRevision = { ...noDelta, current: () => Promise.reject(new Error('no such table: vfs_meta')) }

		for (const fsRevision of [unknown, broken]) {
			const { session } = await bootSession(gatedPlatform(git.client, fsRevision), recordingLogger(warnings))
			await pull(session)
			await pull(session)
		}

		// Two sessions, two pulls each, and not one of them gated.
		expect(git.reads()).toBe(4)
		expect(warnings).toEqual([])
	})

	/** Reports whatever the caller stages, under whichever workdir the session got. */
	function deltaPort(revision: () => number, paths: () => string[]): FsRevision {
		return {
			current: async () => revision(),
			changedSince: async (_since, options) => paths().map((path) => ({ path: `${options?.under ?? ''}/${path}`, deleted: false })),
		}
	}

	function uncommittedCounts(notifications: readonly PluginNotification[]): number[] {
		return notifications
			.filter((entry) => entry.type === 'git_status_changed')
			.map((entry) => (entry.payload as { uncommittedFiles: number }).uncommittedFiles)
	}

	test('extends the known set from the delta instead of walking the tree again', async () => {
		let revision = 1
		let changed: string[] = []
		const git = countingGitClient()
		const { session, notifications } = await bootSession(
			gatedPlatform(git.client, deltaPort(() => revision, () => changed)),
			recordingLogger([]),
		)

		await pull(session)
		revision = 2
		changed = ['added.txt']
		await pull(session)

		// One full read to seed the set; the second answer came from the delta.
		expect(git.reads()).toBe(1)
		expect(uncommittedCounts(notifications)).toEqual([2, 3])
	})

	test('re-reads in full when a commit moves HEAD', async () => {
		let revision = 1
		let oid = 'abc123'
		const git = countingGitClient({ log: async () => [{ oid, message: 'add note\n', committedAt: COMMIT_SECONDS * 1000 }] })
		const { session } = await bootSession(
			gatedPlatform(git.client, deltaPort(() => revision, () => ['added.txt'])),
			recordingLogger([]),
		)

		await pull(session)
		revision = 2
		oid = 'def456'
		await pull(session)

		// A commit is what makes files clean again, and no delta can report that.
		expect(git.reads()).toBe(2)
	})

	test('ignores git\'s own bookkeeping and anything outside the working tree', async () => {
		let revision = 1
		const git = countingGitClient()
		const { session, notifications } = await bootSession(
			gatedPlatform(
				git.client,
				{
					current: async () => revision,
					changedSince: async (_since, options) => [
						{ path: `${options?.under ?? ''}/.git/index`, deleted: false },
						{ path: '/data/sessions/other/session.log', deleted: false },
					],
				},
			),
			recordingLogger([]),
		)

		await pull(session)
		revision = 2
		await pull(session)

		expect(git.reads()).toBe(1)
		// Neither path is an edit, so the count never moved and nothing was notified twice.
		expect(uncommittedCounts(notifications)).toEqual([2])
	})
})
