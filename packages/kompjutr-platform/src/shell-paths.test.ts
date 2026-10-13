import { afterEach, expect, test } from 'bun:test'
import type { ShellGrant, ShellRunResult } from '@roj-ai/sdk/platform'
import { createGit, Workspace } from '@kompjutr/do'
import { createKompjutrPlatform } from './index.js'
import { createKompjutrShellRunner } from './shell.js'
import { BunSqliteStorage } from './testing/storage.js'

const SESSION = '/home/user/session'
const WORKSPACE = '/home/user/workspace'
const REFERENCE = '/home/user/reference'

const storages: BunSqliteStorage[] = []

afterEach(() => {
	for (const storage of storages.splice(0)) storage.close()
})

function text(value: string): Uint8Array {
	return new TextEncoder().encode(value)
}

/** One workspace holding two sessions' directories and checkouts of one repository. */
async function fixture() {
	const storage = new BunSqliteStorage()
	storages.push(storage)
	const ws = new Workspace({
		storage,
		git: createGit(),
		defaultGitIdentity: { name: 'Roj', email: 'roj@example.com' },
	})
	const fs = ws.filesystem
	for (const directory of ['/repo', '/checkouts', '/sessions/a', '/sessions/b', '/reference', '/outside']) {
		fs.mkdir(directory, { recursive: true })
	}
	await ws.git.init({ dir: '/repo', defaultBranch: 'main' })
	fs.writeFile('/repo/note.txt', text('base\n'))
	await ws.git.add({ dir: '/repo', paths: ['note.txt'] })
	await ws.git.commit({ dir: '/repo', message: 'base' })
	for (const name of ['a', 'b']) {
		await ws.git.worktreeAdd({ dir: '/repo', root: `/checkouts/${name}`, target: { kind: 'new-branch', name: `session-${name}` } })
		fs.writeFile(`/checkouts/${name}/note.txt`, text(`${name}\n`))
		fs.writeFile(`/sessions/${name}/marker.txt`, text(`session ${name}\n`))
	}
	fs.writeFile('/reference/marker.txt', text('reference\n'))
	fs.writeFile('/outside/marker.txt', text('outside\n'))

	const runner = createKompjutrShellRunner({ filesystem: fs, git: ws.git, confinement: 'paths' })
	const grants = (name: string): ShellGrant[] => [
		{ path: SESSION, source: `/sessions/${name}`, mode: 'rw' },
		{ path: WORKSPACE, source: `/checkouts/${name}`, mode: 'rw' },
		{ path: REFERENCE, source: '/reference', mode: 'ro' },
	]
	const run = (name: string, command: string, cwd = WORKSPACE): Promise<ShellRunResult> =>
		runner.run({ command, cwd, grants: grants(name), timeoutMs: 10_000 })
	const read = (path: string): string => new TextDecoder().decode(fs.readFile(path))

	return { ws, fs, runner, grants, run, read }
}

function expectFailure(result: ShellRunResult): void {
	expect(result.exitCode).not.toBe(0)
	expect(result.stdout).toBe('')
}

test('declares paths confinement', async () => {
	const { ws, runner } = await fixture()

	expect(runner.confinement).toBe('paths')
	expect(createKompjutrPlatform(ws, { shellConfinement: 'paths' }).shell?.confinement).toBe('paths')
})

test('each run sees only its own grants', async () => {
	const { fs, run, read } = await fixture()

	expect(await run('a', `cat note.txt ${SESSION}/marker.txt; ls /; ls /home/user`)).toMatchObject({
		exitCode: 0,
		stdout: 'a\nsession a\nhome\nreference\nsession\nworkspace\n',
	})
	expect(await run('b', 'cat note.txt')).toMatchObject({ exitCode: 0, stdout: 'b\n' })

	for (const command of ['cat /checkouts/b/note.txt', 'ls /checkouts', 'ls /sessions/b', 'cat /repo/note.txt', 'cat /outside/marker.txt']) {
		const result = await run('a', command)
		expectFailure(result)
		expect(result.stderr).toContain('No such file or directory')
	}
	for (const command of ['printf changed > /checkouts/b/note.txt', 'printf new > /checkouts/b/new.txt', 'rm /sessions/b/marker.txt']) {
		expectFailure(await run('a', command))
	}
	expectFailure(await run('a', 'pwd', '/checkouts/b'))

	expect(await run('a', `printf written > ${SESSION}/written.txt && printf written > written.txt`)).toMatchObject({ exitCode: 0 })
	expect(read('/sessions/a/written.txt')).toBe('written')
	expect(read('/checkouts/a/written.txt')).toBe('written')
	expect(read('/checkouts/b/note.txt')).toBe('b\n')
	expect(read('/sessions/b/marker.txt')).toBe('session b\n')
	expect(fs.exists('/checkouts/b/new.txt')).toBe(false)
	expect(fs.exists('/checkouts/b/written.txt')).toBe(false)
})

test('a read-only grant rejects writes', async () => {
	const { fs, run, read } = await fixture()

	expect(await run('a', `cat ${REFERENCE}/marker.txt`)).toMatchObject({ exitCode: 0, stdout: 'reference\n' })
	for (const command of [`printf changed > ${REFERENCE}/marker.txt`, `printf new > ${REFERENCE}/new.txt`, `rm ${REFERENCE}/marker.txt`]) {
		expectFailure(await run('a', command))
	}
	expect(read('/reference/marker.txt')).toBe('reference\n')
	expect(fs.exists('/reference/new.txt')).toBe(false)
})

test('symlinks that leave their mount fail closed', async () => {
	const { fs, run, read } = await fixture()
	fs.symlink('/outside', '/sessions/a/absolute')
	fs.symlink('../b', '/sessions/a/relative')
	fs.symlink('../../checkouts/a', '/sessions/a/cross-mount')

	for (const link of ['absolute', 'relative', 'cross-mount']) {
		expectFailure(await run('a', `cat ${SESSION}/${link}/marker.txt ${SESSION}/${link}/note.txt`))
		expectFailure(await run('a', `printf changed > ${SESSION}/${link}/marker.txt`))
		expectFailure(await run('a', 'pwd', `${SESSION}/${link}`))
	}
	expect(read('/outside/marker.txt')).toBe('outside\n')
	expect(read('/sessions/b/marker.txt')).toBe('session b\n')
})

test('git works in a virtual cwd and prints virtual paths', async () => {
	const { ws, run } = await fixture()

	const result = await run(
		'a',
		[
			'mkdir sub',
			'printf x > sub/x.txt',
			'git status --short',
			`git add note.txt ${WORKSPACE}/sub/x.txt`,
			`git commit -m '${WORKSPACE} stays verbatim' > /dev/null`,
			'git log -1 --format=%s',
			'git rev-parse --show-toplevel',
			'cd sub && git rev-parse --show-toplevel',
		].join(' && '),
	)

	expect(result.stderr).toBe('')
	expect(result.exitCode).toBe(0)
	expect(result.stdout).toBe(` M note.txt\n?? sub/\n${WORKSPACE} stays verbatim\n${WORKSPACE}\n${WORKSPACE}\n`)
	expect((await ws.git.log({ dir: '/checkouts/a', depth: 1 }))[0]?.message.trim()).toBe(`${WORKSPACE} stays verbatim`)
	expect(await ws.git.status({ dir: '/checkouts/a' })).toEqual([])
	expect(await ws.git.status({ dir: '/checkouts/b' })).toEqual([{ path: 'note.txt', index: ' ', worktree: 'M' }])
})

test('git maps real paths in errors and refuses pathspecs outside the grants', async () => {
	const { ws, run } = await fixture()

	const outsideRepository = await run('a', 'git add ../b/note.txt')
	expect(outsideRepository.exitCode).not.toBe(0)
	expect(outsideRepository.stderr).toContain(`outside repository at '${WORKSPACE}'`)
	expect(outsideRepository.stderr).not.toContain('/checkouts/')

	const otherMount = await run('a', `git add ${SESSION}/marker.txt`)
	expect(otherMount.exitCode).not.toBe(0)
	expect(otherMount.stderr).toContain(`'${SESSION}/marker.txt' is outside repository at '${WORKSPACE}'`)
	expect(otherMount.stderr).not.toContain('/sessions/')

	const outsideGrants = await run('a', 'git add /checkouts/b/note.txt')
	expect(outsideGrants).toMatchObject({ exitCode: 128, stderr: "fatal: '/checkouts/b/note.txt' is outside the mounted paths\n" })
	expect(await ws.git.status({ dir: '/checkouts/b' })).toEqual([{ path: 'note.txt', index: ' ', worktree: 'M' }])
})

test('git init and clone are refused outside writable grants', async () => {
	const { fs, ws, run } = await fixture()
	fs.symlink('/outside', '/sessions/a/escape')

	for (const target of ['/checkouts/new', '/outside/new', `${REFERENCE}/new`, `${SESSION}/escape/new`, '../../../checkouts/new']) {
		const result = await run('a', `git init ${target}`, SESSION)
		expect(result).toMatchObject({ exitCode: 128, stdout: '' })
		expect(result.stderr).toContain('outside the writable mounted paths')
	}
	expect(await run('a', 'git init', '/home/user')).toMatchObject({ exitCode: 128, stderr: "fatal: '/home/user' is outside the mounted paths\n" })
	expect(await run('a', 'git init', REFERENCE)).toMatchObject({ exitCode: 128, stderr: `fatal: '${REFERENCE}' is read-only\n` })
	expect(await run('a', 'git clone https://example.invalid/repo.git /outside/clone', SESSION)).toMatchObject({ exitCode: 128 })
	for (const path of ['/checkouts/new', '/outside/new', '/reference/new', '/reference/.git', '/outside/clone']) {
		expect(fs.exists(path)).toBe(false)
	}

	const created = await run('a', 'git init --initial-branch=main nested', SESSION)
	expect(created).toMatchObject({ exitCode: 0, stdout: `Initialized empty Git repository in ${SESSION}/nested/.git/\n` })
	expect(await ws.git.status({ dir: '/sessions/a/nested' })).toEqual([])
})

test('git refuses a repository that no writable grant shows', async () => {
	const { fs, runner } = await fixture()
	fs.mkdir('/checkouts/a/sub', { recursive: true })

	const result = await runner.run({
		command: 'git status',
		cwd: WORKSPACE,
		grants: [{ path: WORKSPACE, source: '/checkouts/a/sub', mode: 'rw' }],
		timeoutMs: 10_000,
	})

	expect(result).toMatchObject({ exitCode: 128, stdout: '', stderr: `fatal: the repository at '${WORKSPACE}' is not inside a writable mounted path\n` })
})
