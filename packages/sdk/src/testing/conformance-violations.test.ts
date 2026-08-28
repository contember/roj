/**
 * Evidence that the conformance suite can fail.
 *
 * A suite nobody has seen fail is not evidence, and the node platform answers
 * six of the seventeen reported ports — so most of the checks have never met an
 * implementation at all. This file builds one that answers every port, shows the
 * suite passes against it, then breaks exactly one clause at a time and shows
 * which check catches it.
 *
 * The equipped platform is also the only place the optional verbs, `git`, the
 * two log stores and `fsRevision` are exercised in this repo.
 */

import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type {
	ConformancePort,
	ConformanceTarget,
	PlatformInstance,
} from './conformance.js'
import { checksFor, probePlatformPorts, runConformanceCheck } from './conformance.js'
import type {
	FileSystem,
	FsRevision,
	GitClient,
	GitStatusEntry,
	LLMCallRow,
	LiveScheduler,
	LLMCallStore,
	Platform,
	ProcessRunner,
	ReadFilesEntry,
	SessionLogStore,
	WakeHandler,
	WalkEntry,
	WalkOptions,
	WriteFilesEntry,
	WriteFilesOptions,
} from '~/platform/index.js'
import { createBunShellRunner } from '~/bun-platform/shell.js'
import { createNodePlatform } from './node-platform.js'

// ============================================================================
// A platform that answers every port
// ============================================================================

function parentOf(path: string): string {
	const cut = path.lastIndexOf('/')
	return cut <= 0 ? '/' : path.slice(0, cut)
}

function errorCode(error: unknown): string {
	if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
	return String(error)
}

async function walkTree(fs: FileSystem, dir: string, options?: WalkOptions): Promise<WalkEntry[]> {
	const excluded = new Set(options?.exclude ?? [])
	const out: WalkEntry[] = []

	const descend = async (current: string, depthLeft: number): Promise<void> => {
		for (const dirent of await fs.readdir(current, { withFileTypes: true })) {
			if (options?.limit !== undefined && out.length >= options.limit) return
			if (excluded.has(dirent.name)) continue
			if (options?.excludeHidden && dirent.name.startsWith('.')) continue

			const path = `${current}/${dirent.name}`
			const type: WalkEntry['type'] = dirent.isSymbolicLink()
				? 'symlink'
				: dirent.isDirectory()
					? 'directory'
					: dirent.isFile()
						? 'file'
						: 'other'

			// `stat` follows a link, which is the size the contract asks for; a broken one is 0.
			const stats = await fs.stat(path).then((value) => value, () => undefined)
			const size = type === 'directory' ? 0 : stats?.size ?? 0
			const mtime = stats?.mtimeMs ?? 0

			out.push({ path, type, size, mtime })
			if (type === 'directory' && depthLeft > 1) await descend(path, depthLeft - 1)
		}
	}

	await descend(dir, options?.depth ?? Number.POSITIVE_INFINITY)
	return out
}

/** node:fs plus the five optional verbs, each answering what its loop would. */
function equippedFileSystem(base: FileSystem, onWrite: () => void): FileSystem {
	const written = <T>(result: Promise<T>): Promise<T> => result.then((value) => {
		onWrite()
		return value
	})

	return {
		...base,

		writeFile: (path, data) => written(base.writeFile(path, data)),
		appendFile: (path, data) => written(base.appendFile(path, data)),
		mkdir: (path, options) => written(base.mkdir(path, options)),
		unlink: (path) => written(base.unlink(path)),
		rm: (path, options) => written(base.rm(path, options)),
		cp: (source, dest, options) => written(base.cp(source, dest, options)),

		walk: (dir, options) => walkTree(base, dir, options),

		readFiles: (paths) =>
			Promise.all(paths.map(async (path): Promise<ReadFilesEntry> => {
				try {
					return { path, content: await base.readFile(path) }
				} catch (error) {
					return { path, error: errorCode(error) }
				}
			})),

		writeFiles: async (entries: readonly WriteFilesEntry[], options?: WriteFilesOptions): Promise<void> => {
			for (const entry of entries) {
				if (options?.createParents) await base.mkdir(parentOf(entry.path), { recursive: true })
				await base.writeFile(entry.path, entry.content)
			}
			onWrite()
		},

		rmFiles: async (paths, options): Promise<void> => {
			for (const path of paths) await base.rm(path, options)
			onWrite()
		},

		scopeReads: (fn) => fn(),
	}
}

function memorySessionLog(): SessionLogStore {
	const lines = new Map<string, string[]>()
	return {
		append(sessionId, line) {
			const held = lines.get(sessionId) ?? []
			held.push(line)
			lines.set(sessionId, held)
		},
		async read(sessionId, since) {
			const held = lines.get(sessionId) ?? []
			return { lines: held.slice(since), offset: held.length }
		},
		async delete(sessionId) {
			const held = lines.get(sessionId)?.length ?? 0
			lines.delete(sessionId)
			return held
		},
	}
}

function memoryCallStore(): LLMCallStore {
	const calls = new Map<string, Map<string, LLMCallRow>>()
	const of = (sessionId: string): Map<string, LLMCallRow> => {
		const held = calls.get(sessionId) ?? new Map<string, LLMCallRow>()
		calls.set(sessionId, held)
		return held
	}

	return {
		async create(sessionId, row) {
			of(sessionId).set(row.callId, { ...row })
		},
		async complete(sessionId, callId, outcome) {
			const row = of(sessionId).get(callId)
			if (!row) return
			of(sessionId).set(callId, { ...row, ...outcome })
		},
		async get(sessionId, callId) {
			return of(sessionId).get(callId) ?? null
		},
		async list(sessionId, { limit, offset }) {
			const rows = [...of(sessionId).values()].sort((a, b) => b.callId.localeCompare(a.callId))
			return { calls: rows.slice(offset, offset + limit), total: rows.length }
		},
		async delete(sessionId) {
			const held = of(sessionId).size
			calls.delete(sessionId)
			return held
		},
	}
}

function statusCode<T extends string>(char: string | undefined, allowed: readonly T[], fallback: T): T {
	return allowed.find((code) => code === char) ?? fallback
}

function processGitClient(platform: Platform): GitClient {
	const run = async (dir: string, args: string[]): Promise<string> =>
		(await platform.process.execFile('git', args, { cwd: dir })).stdout

	return {
		async status({ dir }) {
			const output = await run(dir, ['status', '--porcelain'])
			return output
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line): GitStatusEntry => ({
					path: line.slice(3),
					index: statusCode(line[0], ['A', 'M', 'D'], ' '),
					worktree: statusCode(line[1], ['A', 'M', 'D', '?'], ' '),
				}))
		},

		async log({ dir, ref, depth }) {
			const args = ['log', ...(depth === undefined ? [] : ['-n', String(depth)]), '--format=%H%x1f%ct%x1f%B%x1e', ref ?? 'HEAD']
			const output = await run(dir, args)
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
			// Rejects outside a repository, and answers undefined where there is no remote HEAD.
			await run(dir, ['rev-parse', '--git-dir'])
			try {
				const output = (await run(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
				return output.startsWith('origin/') ? output.slice('origin/'.length) : undefined
			} catch {
				return undefined
			}
		},
	}
}

function equippedPlatform(): Platform {
	const base = createNodePlatform()
	let revision = 1
	const fsRevision: FsRevision = { current: async () => revision }
	const platform: Platform = {
		...base,
		fs: equippedFileSystem(base.fs, () => {
			revision += 1
		}),
		fsRevision,
		sessionLog: memorySessionLog(),
		llmCallLog: memoryCallStore(),
	}
	return { ...platform, git: processGitClient(platform) }
}

/** `create` with one part of the platform swapped for a broken one. */
function targetOf(name: string, breakIt: (platform: Platform) => Platform): ConformanceTarget {
	return {
		name,
		async create(): Promise<PlatformInstance> {
			const root = await mkdtemp(join(tmpdir(), 'roj-conformance-adv-'))
			return {
				platform: breakIt(equippedPlatform()),
				root,
				dispose: () => rm(root, { recursive: true, force: true }),
			}
		},
	}
}

const equipped = targetOf('equipped', (platform) => platform)

/** Name no host has on its PATH, so every confined run fails to spawn. */
const MISSING_SANDBOX = 'roj-conformance-no-such-sandbox-binary'

/**
 * The CI shape: a runner that still declares `paths` confinement, with the
 * sandbox binary gone. Confined runs reject; unconfined ones are untouched.
 */
function withoutSandbox(platform: Platform): Platform {
	const process: ProcessRunner = {
		execFile: (file, args, options) => platform.process.execFile(file, args, options),
		spawn: (command, args, options) => platform.process.spawn(command === 'bwrap' ? MISSING_SANDBOX : command, args, options),
	}
	return { ...platform, process, shell: createBunShellRunner(process) }
}

const sandboxless = targetOf('no sandbox binary', withoutSandbox)

// ============================================================================
// Running the checks outside bun:test's declaration
// ============================================================================

/** Names of the checks that failed, of the ones this port set is held to. */
async function failingChecks(target: ConformanceTarget, ports?: readonly ConformancePort[]): Promise<string[]> {
	const answered = (await probePlatformPorts(target)).filter((entry) => entry.answered).map((entry) => entry.port)
	const held = ports ? answered.filter((port) => ports.includes(port)) : answered

	const failed: string[] = []
	for (const check of checksFor(held)) {
		try {
			await runConformanceCheck(target, check)
		} catch {
			failed.push(check.name)
		}
	}
	return failed
}

// ============================================================================
// The violations
// ============================================================================

interface Violation {
	/** What the broken platform does that the contract forbids. */
	name: string
	/** Sections the broken clause belongs to. */
	ports: readonly ConformancePort[]
	/** The check that must catch it. */
	caughtBy: string
	break(platform: Platform): Platform
}

const violations: Violation[] = [
	{
		name: 'walk ignores excludeHidden',
		ports: ['fs.walk'],
		caughtBy: 'honours excludeHidden, and does not descend into a hidden directory',
		break: (platform) => ({
			...platform,
			fs: { ...platform.fs, walk: (dir, options) => walkTree(platform.fs, dir, { ...options, excludeHidden: false }) },
		}),
	},
	{
		name: 'walk sizes a symlink by the link, not by the target it stats through',
		ports: ['fs.walk', 'fs.symlinks'],
		caughtBy: 'reports a symlink as one, carrying the size stat gives its target',
		break: (platform) => ({
			...platform,
			fs: {
				...platform.fs,
				walk: async (dir, options) => {
					const entries = await walkTree(platform.fs, dir, options)
					return Promise.all(entries.map(async (entry) => {
						if (entry.type !== 'symlink') return entry
						// What lstat gives: the length of the target path, not the target.
						return { ...entry, size: (await lstat(entry.path)).size }
					}))
				},
			},
		}),
	},
	{
		name: 'lstat follows the link, as stat does',
		ports: ['fs', 'fs.symlinks'],
		caughtBy: 'lstat reports the link itself, and answers for one whose target is gone',
		break: (platform) => ({
			...platform,
			fs: { ...platform.fs, lstat: (path) => platform.fs.stat(path) },
		}),
	},
	{
		name: 'readFiles throws on a missing path instead of reporting it',
		ports: ['fs.readFiles'],
		caughtBy: 'reports a missing path per entry instead of throwing',
		break: (platform) => ({
			...platform,
			fs: {
				...platform.fs,
				readFiles: (paths) =>
					Promise.all(paths.map(async (path): Promise<ReadFilesEntry> => ({ path, content: await platform.fs.readFile(path) }))),
			},
		}),
	},
	{
		name: 'wake adds a second timer instead of replacing the first',
		ports: ['scheduler', 'scheduler.live'],
		caughtBy: 'a second wake for the same key replaces the first rather than adding one',
		break: (platform) => ({ ...platform, scheduler: addingScheduler() }),
	},
	{
		name: 'exists throws for a missing path',
		ports: ['fs'],
		caughtBy: 'exists never throws for a missing path',
		break: (platform) => ({
			...platform,
			fs: {
				...platform.fs,
				exists: async (path) => {
					await platform.fs.access(path)
					return true
				},
			},
		}),
	},
	{
		name: 'fsRevision.current rejects instead of answering undefined',
		ports: ['fsRevision', 'fsRevision.numbered'],
		caughtBy: 'current never rejects — a host that cannot answer returns undefined',
		break: (platform) => ({
			...platform,
			fsRevision: { current: () => Promise.reject(new Error('no such table: vfs_meta')) },
		}),
	},
	{
		name: 'llmCallLog.complete throws on an id the store does not hold',
		ports: ['llmCallLog'],
		caughtBy: 'complete on an id the store does not hold is a no-op, not a throw',
		break: (platform) => {
			const store = platform.llmCallLog
			if (!store) throw new Error('the equipped platform answers llmCallLog')
			return {
				...platform,
				llmCallLog: {
					...store,
					async complete(sessionId, callId, outcome) {
						if (!(await store.get(sessionId, callId))) throw new Error(`unknown call ${callId}`)
						await store.complete(sessionId, callId, outcome)
					},
				},
			}
		},
	},
	{
		name: 'sessionLog.read ignores the cursor and replays everything',
		ports: ['sessionLog'],
		caughtBy: 'the cursor returns what followed it, and only that',
		break: (platform) => {
			const store = platform.sessionLog
			if (!store) throw new Error('the equipped platform answers sessionLog')
			return { ...platform, sessionLog: { ...store, read: (sessionId) => store.read(sessionId, 0) } }
		},
	},
	{
		name: 'shell declares paths confinement but ignores the grants',
		ports: ['shell', 'shell.paths'],
		caughtBy: 'a granted path is reachable and one outside the grants is not',
		break: (platform) => {
			const shell = platform.shell
			if (!shell) throw new Error('the equipped platform answers shell')
			return {
				...platform,
				shell: {
					confinement: 'paths',
					// Runs where the grant points, but unconfined — so the probe still resolves.
					run: (options) => {
						const first = options.grants?.[0]
						return shell.run({ ...options, cwd: first ? first.source ?? first.path : options.cwd, grants: undefined })
					},
				},
			}
		},
	},
	{
		name: 'git.log reports seconds where the port says milliseconds',
		ports: ['git'],
		caughtBy: 'log returns commits newest first, in milliseconds, and honours depth',
		break: (platform) => {
			const git = platform.git
			if (!git) throw new Error('the equipped platform answers git')
			return {
				...platform,
				git: {
					...git,
					log: async (options) =>
						(await git.log(options)).map((commit) => ({ ...commit, committedAt: Math.floor(commit.committedAt / 1000) })),
				},
			}
		},
	},
]

/** A `LiveScheduler` whose `wake` arms a second timer rather than replacing the first. */
function addingScheduler(): LiveScheduler {
	const timers = new Map<string, ReturnType<typeof setTimeout>[]>()
	let handler: WakeHandler | undefined
	return {
		onWake(next: WakeHandler): void {
			handler = next
		},
		async wake(key: string, delayMs: number): Promise<void> {
			const armed = timers.get(key) ?? []
			armed.push(setTimeout(() => void handler?.(key), delayMs))
			timers.set(key, armed)
		},
		async cancel(key: string): Promise<void> {
			for (const timer of timers.get(key) ?? []) clearTimeout(timer)
			timers.delete(key)
		},
	}
}

// ============================================================================
// Tests
// ============================================================================

/** The two facets a single host cannot both answer, or answer off this machine. */
const CONFINEMENT_FACETS: readonly ConformancePort[] = ['shell.paths', 'shell.host']

describe('the conformance suite over a platform that answers every port', () => {
	test('answers every port a single host can answer', async () => {
		const support = await probePlatformPorts(equipped)
		const unanswered = support.filter((entry) => !entry.answered)
		console.log(`[equipped] not answered: ${unanswered.map((entry) => `${entry.port} (${entry.note})`).join(', ') || 'none'}`)

		expect(unanswered.map((entry) => entry.port).filter((port) => !CONFINEMENT_FACETS.includes(port))).toEqual([])
	}, 30_000)

	test('passes every check', async () => {
		const answered = (await probePlatformPorts(equipped)).filter((entry) => entry.answered).map((entry) => entry.port)
		console.log(`[equipped] ${checksFor(answered).length} checks over ${answered.length} ports`)
		expect(await failingChecks(equipped)).toEqual([])
	}, 120_000)
})

describe('a host that declares a confinement it cannot deliver', () => {
	test('skips shell.paths with a reason, and still runs the rest of the shell section', async () => {
		const support = await probePlatformPorts(sandboxless)
		const paths = support.find((entry) => entry.port === 'shell.paths')
		console.log(`[sandboxless] shell.paths answered=${paths?.answered} note=${paths?.note}`)

		expect(paths?.answered).toBe(false)
		expect(paths?.note).toContain('cannot run a confined command')
		expect(await failingChecks(sandboxless, ['shell'])).toEqual([])
	}, 60_000)
})

describe('the conformance suite catches one broken clause at a time', () => {
	for (const violation of violations) {
		test(`catches: ${violation.name}`, async () => {
			const failed = await failingChecks(targetOf(violation.name, violation.break), violation.ports)
			console.log(`[violation] ${violation.name}\n  caught by: ${failed.join(' | ') || 'NOTHING'}`)
			expect(failed).toContain(violation.caughtBy)
		}, 60_000)
	}
})
