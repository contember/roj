/**
 * Executable contract for `Platform`.
 *
 * The ports are interfaces with doc comments, and until now the only thing that
 * said whether an implementation honoured them was the SDK's own test suite —
 * which a host that cannot run the SDK cannot run either. This is the contract
 * on its own: a list of checks, each asserting one clause the doc comments
 * state, runnable against any `Platform`.
 *
 * The checks are data, not `test()` calls. `runPlatformConformance` maps them
 * onto `bun:test`; anything else can execute one directly with
 * `runConformanceCheck` — which is how the suite is itself proven able to fail.
 *
 * Optional ports are probed, never assumed, and a port that is not exercised is
 * reported with the reason. A host that answers nothing does not pass quietly.
 */

import { describe, expect, test } from 'bun:test'
import { sleep } from '~/lib/utils/sleep.js'
import type {
	FileSystem,
	LLMCallRow,
	Platform,
	ReadFilesEntry,
	ShellConfinement,
	ShellGrant,
	ShellRunOptions,
	WalkEntry,
	WalkOptions,
} from '~/platform/index.js'
import { isLiveScheduler } from '~/platform/index.js'

// ============================================================================
// Target
// ============================================================================

/** One platform and the empty directory a check may write in. */
export interface PlatformInstance {
	platform: Platform
	/** Absolute path to a directory that exists and holds nothing. */
	root: string
	dispose?(): Promise<void> | void
}

export interface ConformanceTarget {
	/** Names the host in the run's output. */
	name: string

	/** A fresh platform and scratch root. Called once per check, never shared. */
	create(): Promise<PlatformInstance> | PlatformInstance

	/**
	 * Symlink `linkPath` to `targetPath` — the `fs` port has no verb for it, and
	 * `realpath` and `walk` both have a clause about links. Defaults to `ln -s`
	 * through `platform.process`; checks that need one are skipped where neither
	 * works.
	 */
	symlink?(instance: PlatformInstance, targetPath: string, linkPath: string): Promise<void>

	/**
	 * Build the fixture repository the `git` checks read, at `dir`. Defaults to
	 * `git` through `platform.process`; a host with a stubbed process table
	 * supplies its own. See {@link GIT_FIXTURE} for what it must contain.
	 */
	buildGitRepo?(instance: PlatformInstance, dir: string): Promise<void>
}

/**
 * What a `git` fixture repository must contain, however it is built:
 * branch `feature`, one commit ahead of `main`, HEAD's subject line `second`,
 * a tracked `note.txt` modified in the worktree, and an untracked `scratch.txt`.
 */
export const GIT_FIXTURE: {
	branch: string
	base: string
	headSubject: string
	baseSubject: string
	modified: string
	untracked: string
} = {
	branch: 'feature',
	base: 'main',
	headSubject: 'second',
	baseSubject: 'first',
	modified: 'note.txt',
	untracked: 'scratch.txt',
}

// ============================================================================
// Ports
// ============================================================================

/**
 * What the suite reports on. Most are ports; the dotted ones are facets a port
 * either has or does not — a scheduler that delivers its own wakes, a shell that
 * confines by paths — and they are named so that not exercising one is visible.
 */
export type ConformancePort =
	| 'fs'
	| 'fs.symlinks'
	| 'fs.walk'
	| 'fs.readFiles'
	| 'fs.writeFiles'
	| 'fs.rmFiles'
	| 'fs.scopeReads'
	| 'scheduler'
	| 'scheduler.live'
	| 'shell'
	| 'shell.paths'
	| 'shell.host'
	| 'git'
	| 'fsRevision'
	| 'fsRevision.numbered'
	| 'sessionLog'
	| 'llmCallLog'

/** Report order, and the order sections are declared in. */
export const CONFORMANCE_PORTS: readonly ConformancePort[] = [
	'fs',
	'fs.symlinks',
	'fs.walk',
	'fs.readFiles',
	'fs.writeFiles',
	'fs.rmFiles',
	'fs.scopeReads',
	'scheduler',
	'scheduler.live',
	'shell',
	'shell.paths',
	'shell.host',
	'git',
	'fsRevision',
	'fsRevision.numbered',
	'sessionLog',
	'llmCallLog',
]

/** The five optional `FileSystem` members, as the port names that report them. */
const OPTIONAL_FS_VERBS: readonly ('walk' | 'readFiles' | 'writeFiles' | 'rmFiles' | 'scopeReads')[] = [
	'walk',
	'readFiles',
	'writeFiles',
	'rmFiles',
	'scopeReads',
]

export interface PortSupport {
	port: ConformancePort
	answered: boolean
	/** Why the port is not exercised. Always set when `answered` is false. */
	note?: string
}

// ============================================================================
// Checks
// ============================================================================

export interface ConformanceContext {
	readonly platform: Platform
	/** Empty directory this check owns. */
	readonly root: string
	/** A path under `root`. */
	path(...segments: string[]): string
	/** Symlink `linkPath` to `targetPath`. Only for checks that need `fs.symlinks`. */
	symlink(targetPath: string, linkPath: string): Promise<void>
	/** The fixture repository, built once per check. Only for `git` checks. */
	gitRepo(): Promise<string>
}

export interface ConformanceCheck {
	/** Section the check is reported under. */
	port: ConformancePort
	/** Further ports it needs; absent ones skip it as the section would. */
	needs?: readonly ConformancePort[]
	name: string
	run(ctx: ConformanceContext): Promise<void>
}

// ============================================================================
// Helpers
// ============================================================================

function joinPath(base: string, segments: readonly string[]): string {
	const tail = segments.filter((segment) => segment.length > 0).join('/')
	if (tail.length === 0) return base
	return base.endsWith('/') ? `${base}${tail}` : `${base}/${tail}`
}

function baseName(path: string): string {
	const cut = path.lastIndexOf('/')
	return cut === -1 ? path : path.slice(cut + 1)
}

function relativeTo(base: string, path: string): string {
	return path.startsWith(base) ? path.slice(base.length).replace(/^\/+/, '') : path
}

/** The rejection, or a failure of its own when the promise resolved. */
async function rejection(promise: Promise<unknown>, what: string): Promise<unknown> {
	try {
		await promise
	} catch (error) {
		return error
	}
	throw new Error(`expected ${what} to reject, but it resolved`)
}

/** The code `readFile` threw, the way `ReadFilesEntry.error` names it. */
function errorCode(error: unknown): string | undefined {
	if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
	return undefined
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await sleep(5)
	}
	throw new Error(`${what} did not happen within ${timeoutMs}ms`)
}

const textOf = (bytes: Buffer): string => Buffer.from(bytes).toString('utf-8')

/** Comparable shape of a walked entry: what the contract fixes, nothing more. */
interface WalkShape {
	path: string
	type: WalkEntry['type']
	size: number
}

function walkShapes(base: string, entries: readonly WalkEntry[]): WalkShape[] {
	return entries
		.map((entry) => ({ path: relativeTo(base, entry.path), type: entry.type, size: entry.size }))
		.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * The readdir-and-stat walk `FileSystem.walk` replaces, following the same
 * rules — classifying from the dirent so a link is a link, but sizing from
 * `stat`, which follows it. A broken link is listed at 0, not dropped.
 */
async function walkWithReaddir(fs: FileSystem, dir: string, options?: WalkOptions): Promise<WalkEntry[]> {
	const excluded = new Set(options?.exclude ?? [])
	const out: WalkEntry[] = []

	const descend = async (current: string, depthLeft: number): Promise<void> => {
		for (const dirent of await fs.readdir(current, { withFileTypes: true })) {
			if (options?.limit !== undefined && out.length >= options.limit) return
			if (excluded.has(dirent.name)) continue
			if (options?.excludeHidden && dirent.name.startsWith('.')) continue

			const path = joinPath(current, [dirent.name])
			const type: WalkEntry['type'] = dirent.isSymbolicLink()
				? 'symlink'
				: dirent.isDirectory()
					? 'directory'
					: dirent.isFile()
						? 'file'
						: 'other'

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

/** The per-path `readFile` loop `FileSystem.readFiles` replaces. */
async function readFilesWithLoop(fs: FileSystem, paths: readonly string[]): Promise<ReadFilesEntry[]> {
	return Promise.all(paths.map(async (path): Promise<ReadFilesEntry> => {
		try {
			return { path, content: await fs.readFile(path) }
		} catch (error) {
			return { path, error: errorCode(error) ?? String(error) }
		}
	}))
}

/**
 * A small tree the walk checks read: two levels, a hidden file, a hidden
 * directory with a child, and a directory the `exclude` check names.
 */
async function buildWalkTree(ctx: ConformanceContext): Promise<void> {
	const { platform, path } = ctx
	const fs = platform.fs
	await fs.mkdir(path('sub', 'deep'), { recursive: true })
	await fs.mkdir(path('skipme'), { recursive: true })
	await fs.mkdir(path('.hiddendir'), { recursive: true })
	await fs.writeFile(path('a.txt'), 'aaa')
	await fs.writeFile(path('.hidden.txt'), 'h')
	await fs.writeFile(path('sub', 'b.txt'), 'bb')
	await fs.writeFile(path('sub', 'deep', 'c.txt'), 'cccc')
	await fs.writeFile(path('skipme', 'd.txt'), 'd')
	await fs.writeFile(path('.hiddendir', 'inside.txt'), 'i')
}

async function defaultSymlink(instance: PlatformInstance, targetPath: string, linkPath: string): Promise<void> {
	await instance.platform.process.execFile('ln', ['-s', targetPath, linkPath], {})
}

async function defaultBuildGitRepo(instance: PlatformInstance, dir: string): Promise<void> {
	const { platform } = instance
	const identity = ['-c', 'user.email=conformance@roj.local', '-c', 'user.name=Roj Conformance', '-c', 'commit.gpgsign=false']
	const git = async (...args: string[]): Promise<void> => {
		await platform.process.execFile('git', [...identity, ...args], { cwd: dir })
	}

	await platform.fs.mkdir(dir, { recursive: true })
	await git('init', '-q', '-b', GIT_FIXTURE.base)
	await platform.fs.writeFile(joinPath(dir, [GIT_FIXTURE.modified]), 'one\n')
	await git('add', GIT_FIXTURE.modified)
	await git('commit', '-q', '-m', GIT_FIXTURE.baseSubject)
	await git('checkout', '-q', '-b', GIT_FIXTURE.branch)
	await platform.fs.writeFile(joinPath(dir, [GIT_FIXTURE.modified]), 'two\n')
	await git('commit', '-q', '-a', '-m', `${GIT_FIXTURE.headSubject}\n\nbody paragraph\n`)
	await platform.fs.writeFile(joinPath(dir, [GIT_FIXTURE.modified]), 'three\n')
	await platform.fs.writeFile(joinPath(dir, [GIT_FIXTURE.untracked]), 'scratch\n')
}

function contextFor(target: ConformanceTarget, instance: PlatformInstance): ConformanceContext {
	let repo: Promise<string> | undefined
	return {
		platform: instance.platform,
		root: instance.root,
		path: (...segments) => joinPath(instance.root, segments),
		symlink: (targetPath, linkPath) => (target.symlink ?? defaultSymlink)(instance, targetPath, linkPath),
		gitRepo: () => {
			if (!repo) {
				const dir = joinPath(instance.root, ['fixture-repo'])
				const build = target.buildGitRepo ?? defaultBuildGitRepo
				repo = build(instance, dir).then(() => dir, (error) => {
					throw new Error(
						`could not build the fixture repository: ${error instanceof Error ? error.message : String(error)}. `
							+ 'A host that cannot run `git` supplies ConformanceTarget.buildGitRepo.',
					)
				})
			}
			return repo
		},
	}
}

// ============================================================================
// fs — the required surface
// ============================================================================

const fsChecks: ConformanceCheck[] = [
	{
		port: 'fs',
		name: 'writeFile and readFile round-trip text and bytes',
		async run({ platform, path }) {
			const fs = platform.fs
			const file = path('note.txt')
			await fs.writeFile(file, 'héllo\n')
			expect(await fs.readFile(file, 'utf-8')).toBe('héllo\n')
			expect(textOf(await fs.readFile(file))).toBe('héllo\n')

			const binary = path('bytes.bin')
			await fs.writeFile(binary, new Uint8Array([0, 1, 254, 255]))
			expect([...Buffer.from(await fs.readFile(binary))]).toEqual([0, 1, 254, 255])

			await fs.writeFile(file, 'replaced')
			expect(await fs.readFile(file, 'utf-8')).toBe('replaced')
		},
	},
	{
		port: 'fs',
		name: 'readFile rejects for a missing path',
		async run({ platform, path }) {
			await rejection(platform.fs.readFile(path('missing.txt')), 'readFile of a missing path')
		},
	},
	{
		port: 'fs',
		name: 'appendFile creates a file and adds to the end of one',
		async run({ platform, path }) {
			const fs = platform.fs
			const file = path('log.txt')
			await fs.appendFile(file, 'one\n')
			await fs.appendFile(file, 'two\n')
			expect(await fs.readFile(file, 'utf-8')).toBe('one\ntwo\n')
		},
	},
	{
		port: 'fs',
		name: 'mkdir creates one level, and the whole chain when recursive',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.mkdir(path('one'))
			expect(await fs.exists(path('one'))).toBe(true)

			await rejection(fs.mkdir(path('deep', 'chain')), 'mkdir of a path whose parent is missing')
			await fs.mkdir(path('deep', 'chain'), { recursive: true })
			expect(await fs.exists(path('deep', 'chain'))).toBe(true)

			await rejection(fs.mkdir(path('one')), 'mkdir of an existing directory')
			await fs.mkdir(path('one'), { recursive: true })
		},
	},
	{
		port: 'fs',
		name: 'readdir lists names, and classifies them with withFileTypes',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.mkdir(path('dir'), { recursive: true })
			await fs.writeFile(path('a.txt'), 'a')
			await fs.writeFile(path('b.txt'), 'b')

			expect((await fs.readdir(path())).sort()).toEqual(['a.txt', 'b.txt', 'dir'])

			const dirents = await fs.readdir(path(), { withFileTypes: true })
			const classified = dirents
				.map((dirent) => [dirent.name, dirent.isDirectory(), dirent.isFile()])
				.sort()
			expect(classified).toEqual([
				['a.txt', false, true],
				['b.txt', false, true],
				['dir', true, false],
			])

			await rejection(fs.readdir(path('missing')), 'readdir of a missing directory')
		},
	},
	{
		port: 'fs',
		name: 'stat reports size, kind and a modification time',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.writeFile(path('a.txt'), 'abcde')
			await fs.mkdir(path('dir'), { recursive: true })

			const file = await fs.stat(path('a.txt'))
			expect(file.size).toBe(5)
			expect(file.isFile()).toBe(true)
			expect(file.isDirectory()).toBe(false)
			expect(Number.isFinite(file.mtimeMs)).toBe(true)

			const dir = await fs.stat(path('dir'))
			expect(dir.isDirectory()).toBe(true)

			await rejection(fs.stat(path('missing')), 'stat of a missing path')
		},
	},
	{
		port: 'fs',
		name: 'access resolves for a reachable path and rejects for a missing one',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.writeFile(path('a.txt'), 'a')
			await fs.access(path('a.txt'))
			await fs.access(path())
			await rejection(fs.access(path('missing')), 'access of a missing path')
		},
	},
	{
		port: 'fs',
		name: 'exists never throws for a missing path',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.writeFile(path('a.txt'), 'a')
			await fs.mkdir(path('dir'), { recursive: true })

			expect(await fs.exists(path('a.txt'))).toBe(true)
			expect(await fs.exists(path('dir'))).toBe(true)
			expect(await fs.exists(path('missing.txt'))).toBe(false)
			// The parent is missing too — the corner that makes a stat-and-rethrow fail.
			expect(await fs.exists(path('no', 'such', 'parent', 'file.txt'))).toBe(false)
		},
	},
	{
		port: 'fs',
		name: 'unlink removes one file and rejects for a missing one',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.writeFile(path('a.txt'), 'a')
			await fs.unlink(path('a.txt'))
			expect(await fs.exists(path('a.txt'))).toBe(false)
			await rejection(fs.unlink(path('a.txt')), 'unlink of a missing path')
		},
	},
	{
		port: 'fs',
		name: 'rm with force is a no-op on a missing path, and rejects without it',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.rm(path('missing.txt'), { force: true })
			await fs.rm(path('missing', 'deep'), { recursive: true, force: true })
			await rejection(fs.rm(path('missing.txt')), 'rm of a missing path without force')
		},
	},
	{
		port: 'fs',
		name: 'rm removes a populated directory only when recursive',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.mkdir(path('tree', 'nested'), { recursive: true })
			await fs.writeFile(path('tree', 'nested', 'leaf.txt'), 'leaf')

			await rejection(fs.rm(path('tree')), 'rm of a populated directory without recursive')
			expect(await fs.exists(path('tree', 'nested', 'leaf.txt'))).toBe(true)

			await fs.rm(path('tree'), { recursive: true })
			expect(await fs.exists(path('tree'))).toBe(false)
		},
	},
	{
		port: 'fs',
		name: 'cp copies a file, and a subtree only when recursive',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.mkdir(path('src', 'nested'), { recursive: true })
			await fs.writeFile(path('src', 'top.txt'), 'top')
			await fs.writeFile(path('src', 'nested', 'leaf.txt'), 'leaf')

			await fs.cp(path('src', 'top.txt'), path('copy.txt'))
			expect(await fs.readFile(path('copy.txt'), 'utf-8')).toBe('top')

			await rejection(fs.cp(path('src'), path('flat')), 'cp of a directory without recursive')

			await fs.cp(path('src'), path('deep'), { recursive: true })
			expect(await fs.readFile(path('deep', 'top.txt'), 'utf-8')).toBe('top')
			expect(await fs.readFile(path('deep', 'nested', 'leaf.txt'), 'utf-8')).toBe('leaf')
		},
	},
	{
		port: 'fs',
		name: 'realpath returns a canonical path it can be asked for again',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.writeFile(path('a.txt'), 'a')

			const canonical = await fs.realpath(path('a.txt'))
			expect(baseName(canonical)).toBe('a.txt')
			expect(await fs.exists(canonical)).toBe(true)
			expect(await fs.realpath(canonical)).toBe(canonical)

			await rejection(fs.realpath(path('missing.txt')), 'realpath of a missing path')
		},
	},
	{
		port: 'fs',
		needs: ['fs.symlinks'],
		name: 'realpath resolves a symlink to its target',
		async run({ platform, path, symlink }) {
			const fs = platform.fs
			await fs.writeFile(path('target.txt'), 'target')
			await symlink(path('target.txt'), path('link.txt'))

			expect(await fs.realpath(path('link.txt'))).toBe(await fs.realpath(path('target.txt')))
		},
	},
	{
		port: 'fs',
		name: 'open returns the positional-read handle subset',
		async run({ platform, path }) {
			const fs = platform.fs
			const content = 'abcdefghijklmnop'
			await fs.writeFile(path('a.txt'), content)

			const handle = await fs.open(path('a.txt'))
			try {
				expect((await handle.stat()).size).toBe(content.length)

				const buffer = Buffer.alloc(8, 0)
				const read = await handle.read(buffer, 2, 4, 6)
				expect(read.bytesRead).toBe(4)
				expect(Buffer.from(read.buffer).subarray(2, 6).toString('utf-8')).toBe(content.slice(6, 10))

				// A second read at a different position: the handle carries no cursor of its own.
				const again = await handle.read(Buffer.alloc(3, 0), 0, 3, 0)
				expect(Buffer.from(again.buffer).subarray(0, 3).toString('utf-8')).toBe(content.slice(0, 3))

				expect((await handle.read(Buffer.alloc(4, 0), 0, 4, content.length)).bytesRead).toBe(0)
			} finally {
				await handle.close()
			}
		},
	},
	{
		port: 'fs',
		name: 'tmpDir names a directory that exists',
		async run({ platform }) {
			expect(platform.tmpDir.length).toBeGreaterThan(0)
			expect(await platform.fs.exists(platform.tmpDir)).toBe(true)
		},
	},
]

// ============================================================================
// fs — the optional verbs, each against the loop it replaces
// ============================================================================

const walkChecks: ConformanceCheck[] = [
	{
		port: 'fs.walk',
		name: 'agrees with the readdir-and-stat walk it replaces',
		async run(ctx) {
			const fs = ctx.platform.fs
			await buildWalkTree(ctx)

			const walked = await fs.walk?.(ctx.root)
			const looped = await walkWithReaddir(fs, ctx.root)
			expect(walkShapes(ctx.root, walked ?? [])).toEqual(walkShapes(ctx.root, looped))

			for (const entry of walked ?? []) {
				expect(entry.path.startsWith(ctx.root)).toBe(true)
				expect(Number.isFinite(entry.mtime)).toBe(true)
				// "0 for a directory" — everything else is whatever stat reports.
				if (entry.type === 'directory') expect(entry.size).toBe(0)
			}
		},
	},
	{
		port: 'fs.walk',
		name: 'honours depth',
		async run(ctx) {
			const fs = ctx.platform.fs
			await buildWalkTree(ctx)

			const shallow = walkShapes(ctx.root, (await fs.walk?.(ctx.root, { depth: 1 })) ?? [])
			expect(shallow).toEqual(walkShapes(ctx.root, await walkWithReaddir(fs, ctx.root, { depth: 1 })))
			expect(shallow.map((entry) => entry.path)).not.toContain('sub/b.txt')

			const twoDeep = walkShapes(ctx.root, (await fs.walk?.(ctx.root, { depth: 2 })) ?? [])
			expect(twoDeep.map((entry) => entry.path)).toContain('sub/b.txt')
			expect(twoDeep.map((entry) => entry.path)).not.toContain('sub/deep/c.txt')
		},
	},
	{
		port: 'fs.walk',
		name: 'honours limit, in traversal order',
		async run(ctx) {
			const fs = ctx.platform.fs
			await buildWalkTree(ctx)

			const all = (await fs.walk?.(ctx.root)) ?? []
			expect(all.length).toBeGreaterThan(3)

			const limited = (await fs.walk?.(ctx.root, { limit: 3 })) ?? []
			expect(limited.length).toBe(3)
			// "Entries to return at most, in traversal order" — so a prefix, not a sample.
			expect(limited.map((entry) => entry.path)).toEqual(all.slice(0, 3).map((entry) => entry.path))

			expect(((await fs.walk?.(ctx.root, { limit: all.length + 10 })) ?? []).length).toBe(all.length)
			expect(((await fs.walk?.(ctx.root, { limit: 0 })) ?? []).length).toBe(0)
		},
	},
	{
		port: 'fs.walk',
		name: 'honours exclude, and does not descend into an excluded directory',
		async run(ctx) {
			const fs = ctx.platform.fs
			await buildWalkTree(ctx)

			const walked = walkShapes(ctx.root, (await fs.walk?.(ctx.root, { exclude: ['skipme'] })) ?? [])
			expect(walked).toEqual(walkShapes(ctx.root, await walkWithReaddir(fs, ctx.root, { exclude: ['skipme'] })))
			expect(walked.map((entry) => entry.path)).not.toContain('skipme')
			expect(walked.map((entry) => entry.path)).not.toContain('skipme/d.txt')
			expect(walked.map((entry) => entry.path)).toContain('a.txt')
		},
	},
	{
		port: 'fs.walk',
		name: 'honours excludeHidden, and does not descend into a hidden directory',
		async run(ctx) {
			const fs = ctx.platform.fs
			await buildWalkTree(ctx)

			const walked = walkShapes(ctx.root, (await fs.walk?.(ctx.root, { excludeHidden: true })) ?? [])
			expect(walked).toEqual(walkShapes(ctx.root, await walkWithReaddir(fs, ctx.root, { excludeHidden: true })))
			for (const entry of walked) {
				expect(entry.path.split('/').some((segment) => segment.startsWith('.'))).toBe(false)
			}
			expect(walked.map((entry) => entry.path)).toContain('a.txt')
		},
	},
	{
		port: 'fs.walk',
		needs: ['fs.symlinks'],
		name: 'reports a symlink as one, carrying the size stat gives its target',
		async run(ctx) {
			const fs = ctx.platform.fs
			await fs.writeFile(ctx.path('target.txt'), 'abc')
			await ctx.symlink(ctx.path('target.txt'), ctx.path('good.link'))
			await ctx.symlink(ctx.path('nowhere.txt'), ctx.path('broken.link'))

			const walked = walkShapes(ctx.root, (await fs.walk?.(ctx.root)) ?? [])
			// The loop this replaces stats through the link, so a walk that reported
			// the link's own size would disagree with it for the same tree.
			expect(walked).toEqual([
				{ path: 'broken.link', type: 'symlink', size: 0 },
				{ path: 'good.link', type: 'symlink', size: 3 },
				{ path: 'target.txt', type: 'file', size: 3 },
			])
		},
	},
	{
		port: 'fs.walk',
		name: 'rejects for a missing directory, as the readdir it replaces would',
		async run(ctx) {
			await rejection(Promise.resolve(ctx.platform.fs.walk?.(ctx.path('missing'))), 'walk of a missing directory')
		},
	},
]

const readFilesChecks: ConformanceCheck[] = [
	{
		port: 'fs.readFiles',
		name: 'agrees with the readFile loop it replaces, in the order asked',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.mkdir(path('sub'), { recursive: true })
			await fs.writeFile(path('a.txt'), 'aaa')
			await fs.writeFile(path('sub', 'b.txt'), 'bb')
			await fs.writeFile(path('c.txt'), '')

			// Deliberately not sorted: the contract fixes the order asked, not a sort.
			const paths = [path('sub', 'b.txt'), path('c.txt'), path('a.txt')]
			const batched = (await fs.readFiles?.(paths)) ?? []
			const looped = await readFilesWithLoop(fs, paths)

			expect(batched.map((entry) => entry.path)).toEqual(paths)
			expect(batched.map((entry) => (entry.content ? textOf(entry.content) : undefined)))
				.toEqual(looped.map((entry) => (entry.content ? textOf(entry.content) : undefined)))
			expect(batched.map((entry) => entry.error)).toEqual([undefined, undefined, undefined])
		},
	},
	{
		port: 'fs.readFiles',
		name: 'reports a missing path per entry instead of throwing',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.writeFile(path('a.txt'), 'aaa')
			await fs.writeFile(path('b.txt'), 'bbb')

			const paths = [path('a.txt'), path('missing.txt'), path('b.txt')]
			const batched = (await fs.readFiles?.(paths)) ?? []

			expect(batched.map((entry) => entry.path)).toEqual(paths)
			expect(batched[0]?.content && textOf(batched[0].content)).toBe('aaa')
			expect(batched[2]?.content && textOf(batched[2].content)).toBe('bbb')

			const missing = batched[1]
			expect(missing?.content).toBeUndefined()
			expect(typeof missing?.error).toBe('string')
			expect(missing?.error?.length).toBeGreaterThan(0)

			// "The code `readFile` would have thrown for this path."
			const thrown = errorCode(await rejection(fs.readFile(path('missing.txt')), 'readFile of a missing path'))
			if (thrown !== undefined) expect(missing?.error).toBe(thrown)
		},
	},
	{
		port: 'fs.readFiles',
		name: 'reads a directory the same way the loop does',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.mkdir(path('dir'), { recursive: true })

			const batched = (await fs.readFiles?.([path('dir')])) ?? []
			const looped = await readFilesWithLoop(fs, [path('dir')])
			expect(batched.length).toBe(1)
			expect(batched[0]?.error !== undefined).toBe(looped[0]?.error !== undefined)
		},
	},
]

const writeFilesChecks: ConformanceCheck[] = [
	{
		port: 'fs.writeFiles',
		name: 'agrees with the writeFile loop it replaces',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.writeFile(path('c.txt'), 'stale')

			await fs.writeFiles?.([
				{ path: path('a.txt'), content: 'aaa' },
				{ path: path('b.txt'), content: new Uint8Array([1, 2, 3]) },
				{ path: path('c.txt'), content: 'fresh' },
			])

			expect(await fs.readFile(path('a.txt'), 'utf-8')).toBe('aaa')
			expect([...Buffer.from(await fs.readFile(path('b.txt')))]).toEqual([1, 2, 3])
			expect(await fs.readFile(path('c.txt'), 'utf-8')).toBe('fresh')
		},
	},
	{
		port: 'fs.writeFiles',
		name: 'creates parents only when asked to',
		async run({ platform, path }) {
			const fs = platform.fs

			await rejection(
				Promise.resolve(fs.writeFiles?.([{ path: path('missing', 'a.txt'), content: 'a' }])),
				'writeFiles into a missing directory without createParents',
			)
			expect(await fs.exists(path('missing'))).toBe(false)

			await fs.writeFiles?.([{ path: path('made', 'deep', 'a.txt'), content: 'a' }], { createParents: true })
			expect(await fs.readFile(path('made', 'deep', 'a.txt'), 'utf-8')).toBe('a')
		},
	},
]

const rmFilesChecks: ConformanceCheck[] = [
	{
		port: 'fs.rmFiles',
		name: 'removes every path it is given',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.writeFile(path('a.txt'), 'a')
			await fs.writeFile(path('b.txt'), 'b')
			await fs.writeFile(path('c.txt'), 'c')

			await fs.rmFiles?.([path('a.txt'), path('b.txt')])

			expect(await fs.exists(path('a.txt'))).toBe(false)
			expect(await fs.exists(path('b.txt'))).toBe(false)
			expect(await fs.exists(path('c.txt'))).toBe(true)
		},
	},
	{
		port: 'fs.rmFiles',
		name: 'raises what rm raises for a missing path, and force silences it the same way',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.writeFile(path('a.txt'), 'a')

			await rejection(
				Promise.resolve(fs.rmFiles?.([path('missing.txt')])),
				'rmFiles of a missing path without force',
			)
			await fs.rmFiles?.([path('missing.txt'), path('a.txt')], { force: true })
			expect(await fs.exists(path('a.txt'))).toBe(false)
		},
	},
	{
		port: 'fs.rmFiles',
		name: 'removes a populated directory only when recursive',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.mkdir(path('tree', 'nested'), { recursive: true })
			await fs.writeFile(path('tree', 'nested', 'leaf.txt'), 'leaf')

			await rejection(
				Promise.resolve(fs.rmFiles?.([path('tree')])),
				'rmFiles of a populated directory without recursive',
			)
			expect(await fs.exists(path('tree', 'nested', 'leaf.txt'))).toBe(true)

			await fs.rmFiles?.([path('tree')], { recursive: true })
			expect(await fs.exists(path('tree'))).toBe(false)
		},
	},
]

const scopeReadsChecks: ConformanceCheck[] = [
	{
		port: 'fs.scopeReads',
		name: 'returns what the block returns, and the same reads it would answer outside',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.mkdir(path('sub'), { recursive: true })
			await fs.writeFile(path('a.txt'), 'aaa')
			await fs.writeFile(path('sub', 'b.txt'), 'bb')

			const outside = [await fs.readFile(path('a.txt'), 'utf-8'), (await fs.readdir(path())).sort().join(',')]
			const inside = await fs.scopeReads?.(async () => [
				await fs.readFile(path('a.txt'), 'utf-8'),
				(await fs.readdir(path())).sort().join(','),
			])

			expect(inside).toEqual(outside)
		},
	},
	{
		port: 'fs.scopeReads',
		name: 'propagates the block rejection rather than swallowing it',
		async run({ platform }) {
			const marker = new Error('block failed')
			const caught = await rejection(
				Promise.resolve(platform.fs.scopeReads?.(async () => {
					throw marker
				})),
				'scopeReads over a block that throws',
			)
			expect(caught).toBe(marker)
		},
	},
	{
		port: 'fs.scopeReads',
		name: 'a write inside the scope is visible to a read after it',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.scopeReads?.(async () => {
				await fs.writeFile(path('a.txt'), 'written')
			})
			expect(await fs.readFile(path('a.txt'), 'utf-8')).toBe('written')
		},
	},
]

// ============================================================================
// scheduler
// ============================================================================

/** Keys a wake was delivered for, in the order they arrived. */
function collectWakes(platform: Platform): string[] {
	const fired: string[] = []
	if (isLiveScheduler(platform.scheduler)) platform.scheduler.onWake((key) => void fired.push(key))
	return fired
}

const schedulerChecks: ConformanceCheck[] = [
	{
		port: 'scheduler',
		name: 'wake and cancel resolve, and cancel of an unarmed key is a no-op',
		async run({ platform }) {
			await platform.scheduler.cancel('never-armed')
			await platform.scheduler.wake('armed', 20)
			await platform.scheduler.cancel('armed')
			await platform.scheduler.cancel('armed')
		},
	},
	{
		port: 'scheduler.live',
		name: 'a wake fires after its delay, once, with its own key',
		async run({ platform }) {
			const fired = collectWakes(platform)

			await platform.scheduler.wake('alpha', 40)
			expect(fired).toEqual([])

			await waitUntil(() => fired.length > 0, 2000, 'the wake for alpha')
			await sleep(80)
			expect(fired).toEqual(['alpha'])
		},
	},
	{
		port: 'scheduler.live',
		name: 'a second wake for the same key replaces the first rather than adding one',
		async run({ platform }) {
			const fired = collectWakes(platform)

			await platform.scheduler.wake('alpha', 20)
			await platform.scheduler.wake('alpha', 400)

			// Past the first deadline by a wide margin: the replaced wake must not fire.
			await sleep(150)
			expect(fired).toEqual([])

			await waitUntil(() => fired.length > 0, 3000, 'the replacing wake for alpha')
			await sleep(80)
			expect(fired).toEqual(['alpha'])
		},
	},
	{
		port: 'scheduler.live',
		name: 'cancel before the delay stops it',
		async run({ platform }) {
			const fired = collectWakes(platform)

			await platform.scheduler.wake('alpha', 60)
			await platform.scheduler.wake('beta', 60)
			await platform.scheduler.cancel('alpha')

			await waitUntil(() => fired.length > 0, 2000, 'the wake for beta')
			await sleep(120)
			expect(fired).toEqual(['beta'])
		},
	},
	{
		port: 'scheduler.live',
		name: 'a cancel-then-wake pair issued without awaiting lands in that order',
		async run({ platform }) {
			const fired = collectWakes(platform)

			await platform.scheduler.wake('alpha', 500)
			// Exactly how callers issue it: neither promise awaited before the next call.
			const cancelled = platform.scheduler.cancel('alpha')
			const rearmed = platform.scheduler.wake('alpha', 40)
			await Promise.all([cancelled, rearmed])

			await waitUntil(() => fired.length > 0, 2000, 'the re-armed wake for alpha')
			await sleep(80)
			expect(fired).toEqual(['alpha'])
		},
	},
	{
		port: 'scheduler.live',
		name: 'onWake replaces any previous handler',
		async run({ platform }) {
			const scheduler = platform.scheduler
			if (!isLiveScheduler(scheduler)) throw new Error('scheduler.live checks need a LiveScheduler')

			const first: string[] = []
			const second: string[] = []
			scheduler.onWake((key) => void first.push(key))
			scheduler.onWake((key) => void second.push(key))

			await scheduler.wake('alpha', 20)
			await waitUntil(() => second.length > 0, 2000, 'the wake for alpha')
			await sleep(60)

			expect(second).toEqual(['alpha'])
			expect(first).toEqual([])
		},
	},
]

// ============================================================================
// shell
// ============================================================================

const shellRun = (platform: Platform, options: ShellRunOptions) => {
	if (!platform.shell) throw new Error('shell checks need platform.shell')
	return platform.shell.run(options)
}

const shellChecks: ConformanceCheck[] = [
	{
		port: 'shell',
		name: 'declares one of the three confinements',
		async run({ platform }) {
			const declared: readonly (ShellConfinement | undefined)[] = ['paths', 'host', 'none']
			expect(declared).toContain(platform.shell?.confinement)
		},
	},
	{
		port: 'shell',
		name: 'a non-zero exit resolves rather than rejects',
		async run({ platform, root }) {
			const result = await shellRun(platform, { command: 'exit 3', cwd: root, timeoutMs: 10_000 })
			expect(result.exitCode).toBe(3)
			expect(result.timedOut).toBe(false)
		},
	},
	{
		port: 'shell',
		name: 'buffers stdout and stderr separately',
		async run({ platform, root }) {
			const result = await shellRun(platform, {
				command: 'printf out; printf err 1>&2',
				cwd: root,
				timeoutMs: 10_000,
			})
			expect(result.exitCode).toBe(0)
			expect(result.stdout).toContain('out')
			expect(result.stderr).toContain('err')
			expect(result.stdout).not.toContain('err')
		},
	},
	{
		port: 'shell',
		name: 'stdin reaches the command',
		async run({ platform, root }) {
			const result = await shellRun(platform, {
				command: 'cat',
				cwd: root,
				stdin: 'conformance-stdin\n',
				timeoutMs: 10_000,
			})
			expect(result.exitCode).toBe(0)
			expect(result.stdout).toContain('conformance-stdin')
		},
	},
	{
		port: 'shell',
		name: 'cwd is where the command runs',
		async run({ platform, root }) {
			const result = await shellRun(platform, { command: 'pwd', cwd: root, timeoutMs: 10_000 })
			expect([root, await platform.fs.realpath(root)]).toContain(result.stdout.trim())
		},
	},
	{
		port: 'shell',
		name: 'env reaches the command',
		async run({ platform, root }) {
			const result = await shellRun(platform, {
				command: 'printf %s "$ROJ_CONFORMANCE"',
				cwd: root,
				env: { ROJ_CONFORMANCE: 'present' },
				timeoutMs: 10_000,
			})
			expect(result.stdout).toContain('present')
		},
	},
	{
		port: 'shell',
		name: 'a timeout terminates the command and reports timedOut',
		async run({ platform, root }) {
			const started = Date.now()
			const result = await shellRun(platform, { command: 'sleep 30', cwd: root, timeoutMs: 300 })
			expect(result.timedOut).toBe(true)
			expect(Date.now() - started).toBeLessThan(20_000)
			expect(result.exitCode).not.toBe(0)
		},
	},
	{
		port: 'shell.paths',
		name: 'a granted path is reachable and one outside the grants is not',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.mkdir(path('granted'), { recursive: true })
			await fs.mkdir(path('ungranted'), { recursive: true })
			await fs.writeFile(path('granted', 'inside.txt'), 'inside')
			await fs.writeFile(path('ungranted', 'secret.txt'), 'secret')

			const seen = path('visible')
			const grants: ShellGrant[] = [{ path: seen, source: path('granted'), mode: 'rw' }]

			const reachable = await shellRun(platform, {
				command: 'cat inside.txt',
				cwd: seen,
				grants,
				timeoutMs: 20_000,
			})
			expect(reachable.exitCode).toBe(0)
			expect(reachable.stdout).toContain('inside')

			const blocked = await shellRun(platform, {
				command: `cat ${path('ungranted', 'secret.txt')}`,
				cwd: seen,
				grants,
				timeoutMs: 20_000,
			})
			expect(blocked.exitCode).not.toBe(0)
			expect(blocked.stdout).not.toContain('secret')
		},
	},
	{
		port: 'shell.paths',
		name: 'a read-only grant is readable and not writable',
		async run({ platform, path }) {
			const fs = platform.fs
			await fs.mkdir(path('granted'), { recursive: true })
			await fs.writeFile(path('granted', 'inside.txt'), 'inside')

			const seen = path('visible')
			const grants: ShellGrant[] = [{ path: seen, source: path('granted'), mode: 'ro' }]

			const read = await shellRun(platform, { command: 'cat inside.txt', cwd: seen, grants, timeoutMs: 20_000 })
			expect(read.exitCode).toBe(0)

			const write = await shellRun(platform, {
				command: 'printf x > written.txt',
				cwd: seen,
				grants,
				timeoutMs: 20_000,
			})
			expect(write.exitCode).not.toBe(0)
			expect(await fs.exists(path('granted', 'written.txt'))).toBe(false)
		},
	},
	{
		port: 'shell.host',
		name: 'needs no grants — the filesystem holds nothing but this session',
		async run({ platform, path, root }) {
			await platform.fs.writeFile(path('inside.txt'), 'inside')

			const result = await shellRun(platform, { command: 'cat inside.txt', cwd: root, timeoutMs: 20_000 })
			expect(result.exitCode).toBe(0)
			expect(result.stdout).toContain('inside')
		},
	},
]

// ============================================================================
// git
// ============================================================================

const gitChecks: ConformanceCheck[] = [
	{
		port: 'git',
		name: 'status reports the non-clean paths, and nothing else',
		async run({ platform, gitRepo }) {
			const dir = await gitRepo()
			const status = (await platform.git?.status({ dir })) ?? []

			expect([...status].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
				{ path: GIT_FIXTURE.modified, index: ' ', worktree: 'M' },
				{ path: GIT_FIXTURE.untracked, index: ' ', worktree: '?' },
			])
		},
	},
	{
		port: 'git',
		name: 'log returns commits newest first, in milliseconds, and honours depth',
		async run({ platform, gitRepo }) {
			const dir = await gitRepo()

			const head = (await platform.git?.log({ dir, depth: 1 })) ?? []
			expect(head.length).toBe(1)
			expect(head[0]?.message.split('\n')[0]).toBe(GIT_FIXTURE.headSubject)
			expect(head[0]?.oid.length).toBeGreaterThan(0)
			// Milliseconds, "like every other SDK timestamp" — seconds would be ~1.7e9.
			expect(head[0]?.committedAt).toBeGreaterThan(1e12)

			const all = (await platform.git?.log({ dir })) ?? []
			expect(all.length).toBeGreaterThanOrEqual(2)
			expect(all[0]?.message.split('\n')[0]).toBe(GIT_FIXTURE.headSubject)
			expect(all[all.length - 1]?.message.split('\n')[0]).toBe(GIT_FIXTURE.baseSubject)
			expect(new Set(all.map((commit) => commit.oid)).size).toBe(all.length)

			const base = (await platform.git?.log({ dir, ref: GIT_FIXTURE.base, depth: 1 })) ?? []
			expect(base[0]?.message.split('\n')[0]).toBe(GIT_FIXTURE.baseSubject)
		},
	},
	{
		port: 'git',
		name: 'countAhead counts what is in ref and not in base',
		async run({ platform, gitRepo }) {
			const dir = await gitRepo()

			expect(await platform.git?.countAhead({ dir, base: GIT_FIXTURE.base })).toBe(1)
			expect(await platform.git?.countAhead({ dir, base: GIT_FIXTURE.branch })).toBe(0)
			expect(await platform.git?.countAhead({ dir, base: GIT_FIXTURE.base, ref: GIT_FIXTURE.base })).toBe(0)
		},
	},
	{
		port: 'git',
		name: 'defaultBranch answers a branch name or undefined',
		async run({ platform, gitRepo }) {
			const dir = await gitRepo()
			const branch = await platform.git?.defaultBranch({ dir })
			expect(branch === undefined || (typeof branch === 'string' && branch.length > 0)).toBe(true)
		},
	},
	{
		port: 'git',
		name: 'rejects outside a repository, so the caller reads it as no git state',
		async run({ platform, path }) {
			const dir = path('not-a-repo')
			await platform.fs.mkdir(dir, { recursive: true })

			await rejection(Promise.resolve(platform.git?.status({ dir })), 'status outside a repository')
			await rejection(Promise.resolve(platform.git?.log({ dir })), 'log outside a repository')
			await rejection(
				Promise.resolve(platform.git?.countAhead({ dir, base: GIT_FIXTURE.base })),
				'countAhead outside a repository',
			)

			// `defaultBranch` says undefined means unknown, so outside a repo it may answer either way.
			const branch = await platform.git?.defaultBranch({ dir }).catch(() => undefined)
			expect(branch).toBeUndefined()
		},
	},
]

// ============================================================================
// fsRevision
// ============================================================================

const fsRevisionChecks: ConformanceCheck[] = [
	{
		port: 'fsRevision',
		name: 'current never rejects — a host that cannot answer returns undefined',
		async run({ platform, path }) {
			const first = await platform.fsRevision?.current()
			expect(first === undefined || typeof first === 'number').toBe(true)

			await platform.fs.writeFile(path('a.txt'), 'a')
			const second = await platform.fsRevision?.current()
			expect(second === undefined || typeof second === 'number').toBe(true)
		},
	},
	{
		port: 'fsRevision.numbered',
		name: 'the number moves after a write',
		async run({ platform, path }) {
			const before = await platform.fsRevision?.current()
			await platform.fs.writeFile(path('a.txt'), 'a')
			const after = await platform.fsRevision?.current()

			expect(typeof after).toBe('number')
			expect(after).not.toBe(before)
		},
	},
	{
		port: 'fsRevision.numbered',
		name: 'the number stands still without one',
		async run({ platform, path }) {
			await platform.fs.writeFile(path('a.txt'), 'a')

			const first = await platform.fsRevision?.current()
			const second = await platform.fsRevision?.current()
			await platform.fs.readFile(path('a.txt'))
			const third = await platform.fsRevision?.current()

			expect(second).toBe(first)
			expect(third).toBe(first)
		},
	},
]

// ============================================================================
// sessionLog
// ============================================================================

const SESSION_A = 'conformance-session-a'
const SESSION_B = 'conformance-session-b'

const sessionLogChecks: ConformanceCheck[] = [
	{
		port: 'sessionLog',
		name: 'append returns nothing and round-trips the lines in order',
		async run({ platform }) {
			const store = platform.sessionLog
			if (!store) throw new Error('sessionLog checks need platform.sessionLog')

			expect(store.append(SESSION_A, '{"n":1}')).toBeUndefined()
			store.append(SESSION_A, '{"n":2}')
			store.append(SESSION_A, '{"n":3}')

			const page = await store.read(SESSION_A, 0)
			expect(page.lines).toEqual(['{"n":1}', '{"n":2}', '{"n":3}'])
		},
	},
	{
		port: 'sessionLog',
		name: 'the cursor returns what followed it, and only that',
		async run({ platform }) {
			const store = platform.sessionLog
			if (!store) throw new Error('sessionLog checks need platform.sessionLog')

			store.append(SESSION_A, '{"n":1}')
			store.append(SESSION_A, '{"n":2}')

			const first = await store.read(SESSION_A, 0)
			expect(first.lines.length).toBe(2)

			// Nothing new: the same cursor comes back with nothing behind it.
			expect((await store.read(SESSION_A, first.offset)).lines).toEqual([])
			expect((await store.read(SESSION_A, first.offset)).offset).toBe(first.offset)

			store.append(SESSION_A, '{"n":3}')
			const second = await store.read(SESSION_A, first.offset)
			expect(second.lines).toEqual(['{"n":3}'])
			// Re-reading the same cursor answers the same — a cursor is a position, not a queue.
			expect((await store.read(SESSION_A, first.offset)).lines).toEqual(['{"n":3}'])
			expect((await store.read(SESSION_A, second.offset)).lines).toEqual([])
		},
	},
	{
		port: 'sessionLog',
		name: 'a session with nothing in it reads empty',
		async run({ platform }) {
			const store = platform.sessionLog
			if (!store) throw new Error('sessionLog checks need platform.sessionLog')

			expect((await store.read('conformance-never-written', 0)).lines).toEqual([])
		},
	},
	{
		port: 'sessionLog',
		name: 'one session does not see another',
		async run({ platform }) {
			const store = platform.sessionLog
			if (!store) throw new Error('sessionLog checks need platform.sessionLog')

			store.append(SESSION_A, '{"who":"a"}')
			store.append(SESSION_B, '{"who":"b"}')

			expect((await store.read(SESSION_A, 0)).lines).toEqual(['{"who":"a"}'])
			expect((await store.read(SESSION_B, 0)).lines).toEqual(['{"who":"b"}'])
		},
	},
	{
		port: 'sessionLog',
		name: 'delete drops one session and reports how many went',
		async run({ platform }) {
			const store = platform.sessionLog
			if (!store) throw new Error('sessionLog checks need platform.sessionLog')

			store.append(SESSION_A, '{"n":1}')
			store.append(SESSION_A, '{"n":2}')
			store.append(SESSION_B, '{"n":1}')

			expect(await store.delete(SESSION_A)).toBe(2)
			expect((await store.read(SESSION_A, 0)).lines).toEqual([])
			expect((await store.read(SESSION_B, 0)).lines).toEqual(['{"n":1}'])
			expect(await store.delete('conformance-never-written')).toBe(0)
		},
	},
]

// ============================================================================
// llmCallLog
// ============================================================================

/** Fixed-width and ordered, the way a UUIDv7 is — so `list` can be checked on it. */
const callId = (n: number): string => `0198e9c0-0000-7000-8000-${String(n).padStart(12, '0')}`

function callRow(n: number): LLMCallRow {
	return {
		callId: callId(n),
		agentId: 'conformance-agent',
		createdAt: 1_700_000_000_000 + n,
		status: 'running',
		model: 'test-model',
		request: JSON.stringify({ n }),
	}
}

const llmCallLogChecks: ConformanceCheck[] = [
	{
		port: 'llmCallLog',
		name: 'create and get round-trip the row',
		async run({ platform }) {
			const store = platform.llmCallLog
			if (!store) throw new Error('llmCallLog checks need platform.llmCallLog')

			if (store.maxBlobBytes !== undefined) expect(store.maxBlobBytes).toBeGreaterThan(0)

			const row = callRow(1)
			await store.create(SESSION_A, row)

			expect(await store.get(SESSION_A, row.callId)).toEqual(row)
			expect(await store.get(SESSION_A, callId(999))).toBeNull()
			expect(await store.get(SESSION_B, row.callId)).toBeNull()
		},
	},
	{
		port: 'llmCallLog',
		name: 'complete attaches the outcome and leaves the request alone',
		async run({ platform }) {
			const store = platform.llmCallLog
			if (!store) throw new Error('llmCallLog checks need platform.llmCallLog')

			const row = callRow(1)
			await store.create(SESSION_A, row)
			await store.complete(SESSION_A, row.callId, {
				status: 'success',
				completedAt: 1_700_000_005_000,
				durationMs: 5000,
				providerRequestId: 'req-1',
				response: '{"text":"hi"}',
				metrics: '{"tokens":7}',
			})

			const stored = await store.get(SESSION_A, row.callId)
			expect(stored?.status).toBe('success')
			expect(stored?.completedAt).toBe(1_700_000_005_000)
			expect(stored?.durationMs).toBe(5000)
			expect(stored?.providerRequestId).toBe('req-1')
			expect(stored?.response).toBe('{"text":"hi"}')
			expect(stored?.metrics).toBe('{"tokens":7}')
			expect(stored?.request).toBe(row.request)
			expect(stored?.error).toBeUndefined()
		},
	},
	{
		port: 'llmCallLog',
		name: 'complete on an id the store does not hold is a no-op, not a throw',
		async run({ platform }) {
			const store = platform.llmCallLog
			if (!store) throw new Error('llmCallLog checks need platform.llmCallLog')

			await store.create(SESSION_A, callRow(1))
			await store.complete(SESSION_A, callId(999), {
				status: 'error',
				completedAt: 1_700_000_005_000,
				durationMs: 5000,
				error: '{"message":"reaped"}',
			})

			expect(await store.get(SESSION_A, callId(999))).toBeNull()
			expect((await store.list(SESSION_A, { limit: 10, offset: 0 })).total).toBe(1)
		},
	},
	{
		port: 'llmCallLog',
		name: 'list pages newest first by callId, with a total that ignores limit and offset',
		async run({ platform }) {
			const store = platform.llmCallLog
			if (!store) throw new Error('llmCallLog checks need platform.llmCallLog')

			for (const n of [1, 2, 3]) await store.create(SESSION_A, callRow(n))
			await store.create(SESSION_B, callRow(9))

			const firstPage = await store.list(SESSION_A, { limit: 2, offset: 0 })
			expect(firstPage.total).toBe(3)
			expect(firstPage.calls.map((call) => call.callId)).toEqual([callId(3), callId(2)])

			const secondPage = await store.list(SESSION_A, { limit: 2, offset: 2 })
			expect(secondPage.total).toBe(3)
			expect(secondPage.calls.map((call) => call.callId)).toEqual([callId(1)])

			expect((await store.list(SESSION_A, { limit: 10, offset: 10 })).calls).toEqual([])
			expect((await store.list(SESSION_B, { limit: 10, offset: 0 })).total).toBe(1)
			expect((await store.list('conformance-never-written', { limit: 10, offset: 0 })).total).toBe(0)
		},
	},
	{
		port: 'llmCallLog',
		name: 'delete drops one session and reports how many went',
		async run({ platform }) {
			const store = platform.llmCallLog
			if (!store) throw new Error('llmCallLog checks need platform.llmCallLog')

			for (const n of [1, 2]) await store.create(SESSION_A, callRow(n))
			await store.create(SESSION_B, callRow(9))

			expect(await store.delete(SESSION_A)).toBe(2)
			expect((await store.list(SESSION_A, { limit: 10, offset: 0 })).total).toBe(0)
			expect(await store.get(SESSION_A, callId(1))).toBeNull()
			expect((await store.list(SESSION_B, { limit: 10, offset: 0 })).total).toBe(1)
			expect(await store.delete('conformance-never-written')).toBe(0)
		},
	},
]

/** Every clause the ports state, as one list. */
export const platformConformanceChecks: readonly ConformanceCheck[] = [
	...fsChecks,
	...walkChecks,
	...readFilesChecks,
	...writeFilesChecks,
	...rmFilesChecks,
	...scopeReadsChecks,
	...schedulerChecks,
	...shellChecks,
	...gitChecks,
	...fsRevisionChecks,
	...sessionLogChecks,
	...llmCallLogChecks,
]

// ============================================================================
// Probing what a host answers
// ============================================================================

/** Which ports the target answers, and why it does not answer the rest. */
export async function probePlatformPorts(target: ConformanceTarget): Promise<PortSupport[]> {
	const instance = await target.create()
	try {
		return await probeInstance(target, instance)
	} finally {
		await instance.dispose?.()
	}
}

async function probeInstance(target: ConformanceTarget, instance: PlatformInstance): Promise<PortSupport[]> {
	const { platform } = instance
	const support: PortSupport[] = []
	const add = (port: ConformancePort, answered: boolean, note?: string): void => {
		support.push(answered ? { port, answered } : { port, answered, note: note ?? 'port absent' })
	}

	add('fs', true)
	add('fs.symlinks', await canSymlink(target, instance), 'the host cannot make a symlink and the target declares no `symlink`')

	for (const verb of OPTIONAL_FS_VERBS) {
		add(`fs.${verb}`, typeof platform.fs[verb] === 'function')
	}

	add('scheduler', true)
	add('scheduler.live', isLiveScheduler(platform.scheduler), 'the scheduler does not deliver its own wakes')

	const confinement = platform.shell?.confinement
	add('shell', platform.shell !== undefined)
	const confines = await probeConfinement(instance)
	add('shell.paths', confines.ok, confines.note)
	add('shell.host', confinement === 'host', `confinement is ${confinement ?? 'absent'}`)

	const buildable = platform.git !== undefined && await canBuildGitRepo(target, platform)
	add('git', buildable, platform.git === undefined ? undefined : 'no way to build a fixture repository — declare ConformanceTarget.buildGitRepo')

	add('fsRevision', platform.fsRevision !== undefined)
	const numbered = await probeRevision(platform)
	add('fsRevision.numbered', numbered.ok, numbered.note)

	add('sessionLog', platform.sessionLog !== undefined)
	add('llmCallLog', platform.llmCallLog !== undefined)

	return support
}

async function canSymlink(target: ConformanceTarget, instance: PlatformInstance): Promise<boolean> {
	const probePath = joinPath(instance.root, ['.conformance-symlink-probe'])
	try {
		await (target.symlink ?? defaultSymlink)(instance, instance.root, probePath)
		return await instance.platform.fs.exists(probePath)
	} catch {
		return false
	}
}

async function canBuildGitRepo(target: ConformanceTarget, platform: Platform): Promise<boolean> {
	if (target.buildGitRepo) return true
	try {
		await platform.process.execFile('git', ['--version'], {})
		return true
	} catch {
		return false
	}
}

/** First line of an error, short enough to carry in a test name. */
function messageOf(error: unknown): string {
	const text = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''
	return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

/**
 * Whether the host can run a confined command at all — not whether it confines
 * correctly, which is what the `shell.paths` checks are for.
 *
 * Resolving is the signal, whatever the exit code: a runner that ran and answered
 * wrongly must fail those checks, and only one that cannot run at all is skipped.
 */
async function probeConfinement(instance: PlatformInstance): Promise<{ ok: boolean; note?: string }> {
	const { platform } = instance
	const shell = platform.shell
	if (!shell) return { ok: false, note: 'port absent' }
	if (shell.confinement !== 'paths') return { ok: false, note: `confinement is ${shell.confinement}` }

	const dir = joinPath(instance.root, ['.conformance-confinement-probe'])
	try {
		await platform.fs.mkdir(dir, { recursive: true })
		await shell.run({ command: 'exit 0', cwd: dir, grants: [{ path: dir, mode: 'rw' }], timeoutMs: 30_000 })
		return { ok: true }
	} catch (error) {
		return { ok: false, note: `declares \`paths\` confinement but cannot run a confined command: ${messageOf(error)}` }
	}
}

async function probeRevision(platform: Platform): Promise<{ ok: boolean; note?: string }> {
	if (!platform.fsRevision) return { ok: false, note: 'port absent' }
	try {
		const current = await platform.fsRevision.current()
		return typeof current === 'number' ? { ok: true } : { ok: false, note: 'current() answers undefined' }
	} catch {
		return { ok: false, note: 'current() rejected' }
	}
}

// ============================================================================
// Running
// ============================================================================

/** Run one check against a fresh instance of the target. Throws what it asserts. */
export async function runConformanceCheck(target: ConformanceTarget, check: ConformanceCheck): Promise<void> {
	const instance = await target.create()
	try {
		await check.run(contextFor(target, instance))
	} finally {
		await instance.dispose?.()
	}
}

/** The checks a host answering `answered` should be held to. */
export function checksFor(answered: Iterable<ConformancePort>): ConformanceCheck[] {
	const ports = new Set(answered)
	return platformConformanceChecks.filter((check) =>
		ports.has(check.port) && (check.needs ?? []).every((port) => ports.has(port))
	)
}

function describeSkip(support: PortSupport): string {
	return support.note ? `${support.port} (${support.note})` : support.port
}

/**
 * Declare the suite against `target`, one section per port.
 *
 * Ports the host does not answer are declared skipped rather than dropped, and
 * the two `ports:` tests carry the exercised and skipped sets in their names —
 * so a host that answers almost nothing says so in the run's output.
 */
export function runPlatformConformance(target: ConformanceTarget): void {
	describe(`platform conformance: ${target.name}`, async () => {
		const support = await probePlatformPorts(target)
		const exercised = support.filter((entry) => entry.answered).map((entry) => entry.port)
		const answered = new Set(exercised)
		const skipped = support.filter((entry) => !entry.answered)

		console.log(
			`[conformance] ${target.name}\n`
				+ `  exercised: ${exercised.join(', ') || 'none'}\n`
				+ `  skipped:   ${skipped.map(describeSkip).join(', ') || 'none'}`,
		)

		for (const port of CONFORMANCE_PORTS) {
			const checks = platformConformanceChecks.filter((check) => check.port === port)
			if (checks.length === 0) continue

			describe(port, () => {
				for (const check of checks) {
					const missing = [port, ...(check.needs ?? [])].filter((needed) => !answered.has(needed))
					const declareTest = missing.length === 0 ? test : test.skip
					const name = missing.length === 0 ? check.name : `${check.name} — needs ${missing.join(', ')}`
					declareTest(name, () => runConformanceCheck(target, check))
				}
			})
		}

		test(`ports exercised: ${exercised.join(', ') || 'none'}`, async () => {
			const again = await probePlatformPorts(target)
			expect(again.filter((entry) => entry.answered).map((entry) => entry.port)).toEqual(exercised)
		})

		test(`ports skipped: ${skipped.map(describeSkip).join(', ') || 'none'}`, () => {
			// A skip with no reason is a silent one, which is the thing this suite must not allow.
			expect(skipped.filter((entry) => entry.note === undefined)).toEqual([])
		})
	})
}
