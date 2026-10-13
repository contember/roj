import { posix } from 'node:path'
import type { GitCliResult, GitCliRunner } from '@kompjutr/do'
import type { Filesystem } from '@kompjutr/do/fs'
import type { GrantMounts, MountedPath } from './mounts.js'

/** Commands whose every absolute operand is a pathspec. */
const PATHSPEC_OPERANDS = new Set(['status', 'ls-files', 'add', 'restore'])
/** Commands that read pathspecs only after `--`. */
const PATHSPEC_AFTER_SEPARATOR = new Set(['diff', 'log', 'reset', 'checkout'])
/** `git clone` options that take their value as the next argument. */
const CLONE_VALUED_OPTIONS = new Set(['--depth', '--branch', '-b', '--origin', '-o'])
/** Unquoted paths in Git's messages: after whitespace or a quote, up to the next one. */
const MESSAGE_PATH = /(?<=^|[\s'"])\/[^\s'"]*/g

type Translated = { ok: true; argv: readonly string[] } | { ok: false; message: string }

/**
 * Runs Git for a shell confined to a mounted view.
 *
 * Git keeps the real filesystem, because checkout routing and dirty tracking work
 * on real paths. This runner moves the shell's virtual cwd and absolute path
 * operands into real space, refuses what no writable mount shows, and maps the
 * real paths Git prints back to virtual ones.
 */
export function createConfinedGitRunner(git: GitCliRunner, view: Filesystem, mounts: GrantMounts): GitCliRunner {
	return {
		async runCli(input, options) {
			const virtualCwd = view.realpath(input.cwd ?? '/')
			const cwd = mounts.toReal(virtualCwd)
			if (cwd === undefined) return refused(`'${virtualCwd}' is outside the mounted paths`)

			const translated = await translate(git, view, mounts, input.argv, virtualCwd, cwd)
			if (!translated.ok) return refused(translated.message)

			const result = await git.runCli({ ...input, argv: translated.argv, cwd: cwd.real }, options)
			const toVirtual = (text: string): string =>
				text.replace(MESSAGE_PATH, (match) => {
					// `path: message` puts a colon after the path.
					const path = match.endsWith(':') ? match.slice(0, -1) : match
					return `${mounts.toVirtual(path, cwd.mount) ?? path}${match.slice(path.length)}`
				})
			return {
				...result,
				stdout: printsRealPaths(input.argv) ? toVirtual(result.stdout) : result.stdout,
				stderr: toVirtual(result.stderr),
			}
		},
	}
}

async function translate(
	git: GitCliRunner,
	view: Filesystem,
	mounts: GrantMounts,
	argv: readonly string[],
	virtualCwd: string,
	cwd: MountedPath,
): Promise<Translated> {
	const command = argv[0]
	if (command === 'init' || command === 'clone') {
		const index = command === 'init' ? initDirectoryIndex(argv) : cloneDirectoryIndex(argv)
		const directory = index === undefined ? undefined : argv[index]
		if (index === undefined || directory === undefined) {
			// Both create in or directly under the cwd.
			return cwd.mount.mode === 'rw' ? { ok: true, argv } : { ok: false, message: `'${virtualCwd}' is read-only` }
		}
		const target = writableTarget(view, mounts, posix.resolve(virtualCwd, directory))
		if (target === undefined) return { ok: false, message: `'${directory}' is outside the writable mounted paths` }
		const translatedArgv = [...argv]
		translatedArgv[index] = target
		return { ok: true, argv: translatedArgv }
	}

	const translatedArgv = [...argv]
	for (const index of pathspecIndexes(argv)) {
		const pathspec = argv[index]
		if (pathspec === undefined || !pathspec.startsWith('/')) continue
		const real = mounts.toReal(posix.resolve(pathspec))
		if (real === undefined) return { ok: false, message: `'${pathspec}' is outside the mounted paths` }
		translatedArgv[index] = real.real
	}

	const repository = await git.runCli({ argv: ['rev-parse', '--show-toplevel'], cwd: cwd.real })
	// A cwd outside any repository fails the command itself with Git's own message.
	if (repository.exitCode === 0 && !mounts.isWritable(repository.stdout.trimEnd())) {
		return { ok: false, message: `the repository at '${virtualCwd}' is not inside a writable mounted path` }
	}
	return { ok: true, argv: translatedArgv }
}

/**
 * The real path a new repository would take, when a writable mount shows it.
 * The existing part resolves through the view, so a symlink leaving its mount fails here
 * instead of being followed by Git in real space.
 */
function writableTarget(view: Filesystem, mounts: GrantMounts, virtualTarget: string): string | undefined {
	let existing = virtualTarget
	const missing: string[] = []
	while (view.statTarget(existing) === null) {
		if (existing === '/' || view.stat(existing) !== null) return undefined
		missing.unshift(posix.basename(existing))
		existing = posix.dirname(existing)
	}
	const target = mounts.toReal(posix.join(view.realpath(existing), ...missing))
	return target?.mount.mode === 'rw' ? target.real : undefined
}

function initDirectoryIndex(argv: readonly string[]): number | undefined {
	const index = argv.findIndex((argument, position) => position > 0 && !argument.startsWith('-'))
	return index === -1 ? undefined : index
}

function cloneDirectoryIndex(argv: readonly string[]): number | undefined {
	const operands: number[] = []
	for (let index = 1; index < argv.length; index++) {
		const argument = argv[index]
		if (argument === undefined) break
		if (CLONE_VALUED_OPTIONS.has(argument)) index++
		else if (!argument.startsWith('-')) operands.push(index)
	}
	return operands[1]
}

function pathspecIndexes(argv: readonly string[]): number[] {
	const command = argv[0] ?? ''
	const separator = argv.indexOf('--', 1)
	const indexes: number[] = []
	for (let index = 1; index < argv.length; index++) {
		if (index === separator) continue
		if (PATHSPEC_OPERANDS.has(command) || (PATHSPEC_AFTER_SEPARATOR.has(command) && separator !== -1 && index > separator)) {
			indexes.push(index)
		}
	}
	return indexes
}

/** Commands whose stdout names a real path rather than repository content. */
function printsRealPaths(argv: readonly string[]): boolean {
	return argv[0] === 'init' || argv[0] === 'clone' || (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel')
}

function refused(message: string): GitCliResult {
	return { stdout: '', stderr: `fatal: ${message}\n`, exitCode: 128, truncated: false }
}
