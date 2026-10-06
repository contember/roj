import { expect, spyOn, test } from 'bun:test'
import { createGit, Workspace } from '@kompjutr/do'
import { createKompjutrShellRunner } from './shell.js'
import { BunSqliteStorage } from './testing/storage.js'

function workspace(): Workspace {
	return new Workspace({
		storage: new BunSqliteStorage(),
		git: createGit(),
		defaultGitIdentity: { name: 'Roj', email: 'roj@example.com' },
	})
}

test('each run uses its requested cwd and forwards env and stdin', async () => {
	const ws = workspace()
	ws.filesystem.mkdir("/one's", { recursive: true })
	ws.filesystem.mkdir('/two', { recursive: true })
	const runner = createKompjutrShellRunner({ filesystem: ws.filesystem })

	const first = await runner.run({
		command: 'cd /two; cat; printf %s "$VALUE"',
		cwd: "/one's",
		env: { VALUE: '-env' },
		stdin: 'stdin',
		timeoutMs: 1,
	})
	const second = await runner.run({
		command: 'pwd',
		cwd: "/one's",
		timeoutMs: 1,
	})

	expect(first).toMatchObject({
		stdout: 'stdin-env',
		exitCode: 0,
		timedOut: false,
	})
	expect(second).toMatchObject({
		stdout: "/one's\n",
		exitCode: 0,
		timedOut: false,
	})
	expect(runner.supportsTimeout).toBe(false)
	expect(runner.confinement).toBe('none')
})

test('concurrent runs keep cwd, env and stdin local to each invocation', async () => {
	const ws = workspace()
	ws.filesystem.mkdir('/A', { recursive: true })
	ws.filesystem.mkdir('/B', { recursive: true })
	const runner = createKompjutrShellRunner({ filesystem: ws.filesystem })

	const results = await Promise.all(
		['A', 'B'].map((name) =>
			runner.run({
				command: `pwd; echo ${name} > ${name.toLowerCase()}.txt; cat; printf '%s' "$VALUE"`,
				cwd: `/${name}`,
				env: { VALUE: `env-${name}` },
				stdin: `stdin-${name}\n`,
				timeoutMs: 1,
			}),
		),
	)

	expect(results.map((result) => result.stdout)).toEqual(['/A\nstdin-A\nenv-A', '/B\nstdin-B\nenv-B'])
	expect(results.map((result) => result.exitCode)).toEqual([0, 0])
	expect(new TextDecoder().decode(ws.filesystem.readFile('/A/a.txt'))).toBe('A\n')
	expect(new TextDecoder().decode(ws.filesystem.readFile('/B/b.txt'))).toBe('B\n')
	expect(ws.filesystem.exists('/A/b.txt')).toBe(false)
	expect(ws.filesystem.exists('/B/a.txt')).toBe(false)
	expect(ws.db.all('SELECT session_id FROM shell_sessions')).toEqual([{ session_id: 'default' }])
})

test('concurrent supported commands overlap without sharing invocation state', async () => {
	const ws = workspace()
	ws.filesystem.mkdir('/A', { recursive: true })
	ws.filesystem.mkdir('/B', { recursive: true })
	const git = ws.git
	const runCli = git.runCli.bind(git)
	const barrier = Promise.withResolvers<void>()
	const entered: (string | undefined)[] = []
	const runCliSpy = spyOn(git, 'runCli').mockImplementation(async (input, options) => {
		entered.push(input.cwd)
		if (entered.length === 2) barrier.resolve()
		await barrier.promise
		return runCli(input, options)
	})
	const runner = createKompjutrShellRunner({ filesystem: ws.filesystem, git })

	try {
		const results = await Promise.all(
			['A', 'B'].map((name) =>
				runner.run({
					command: 'cat > stdin.txt; git init --initial-branch=main; pwd; printf "%s" "$VALUE"',
					cwd: `/${name}`,
					env: { VALUE: `env-${name}` },
					stdin: `stdin-${name}`,
					timeoutMs: 1,
				}),
			),
		)
		expect(entered).toEqual(['/A', '/B'])
		for (const [index, name] of ['A', 'B'].entries()) {
			expect(results[index]?.exitCode).toBe(0)
			expect(results[index]?.stdout).toContain(`/${name}\nenv-${name}`)
			expect(new TextDecoder().decode(ws.filesystem.readFile(`/${name}/stdin.txt`))).toBe(`stdin-${name}`)
		}
		expect(ws.db.all('SELECT session_id FROM shell_sessions')).toEqual([{ session_id: 'default' }])
	} finally {
		barrier.resolve()
		runCliSpy.mockRestore()
	}
})

test('injects Git from the same workspace', async () => {
	const ws = workspace()
	ws.filesystem.mkdir('/repo', { recursive: true })
	ws.filesystem.writeFile('/repo/note.txt', new TextEncoder().encode('hello\n'))
	const runner = createKompjutrShellRunner({
		filesystem: ws.filesystem,
		git: ws.git,
		confinement: 'host',
	})

	const result = await runner.run({
		command: 'git init --initial-branch=main && git add note.txt && git commit -m initial && git status --short',
		cwd: '/repo',
		timeoutMs: 10_000,
	})

	expect(result.exitCode, result.stderr).toBe(0)
	expect(result.stdout).not.toContain('?? note.txt')
	expect((await ws.git.log({ dir: '/repo', depth: 1 }))[0]?.message.trim()).toBe('initial')
	expect(runner.confinement).toBe('host')
})

test.each(['/missing', '/regular-file'])('invalid cwd %s prevents the entire submitted script from running', async (cwd) => {
	const ws = workspace()
	ws.filesystem.mkdir('/prev', { recursive: true })
	ws.filesystem.writeFile('/regular-file', new TextEncoder().encode('original'))
	const runner = createKompjutrShellRunner({ filesystem: ws.filesystem })

	expect((await runner.run({ command: 'true', cwd: '/prev', timeoutMs: 1 })).exitCode).toBe(0)

	for (const command of [
		'true; echo OOPS > wrong.txt',
		'echo BEFORE > /before.txt; true && echo OOPS > wrong.txt; echo AFTER > /after.txt',
		'false || echo OOPS > wrong.txt\necho AFTER > /after.txt',
	]) {
		const result = await runner.run({ command, cwd, timeoutMs: 1 })

		expect(result.exitCode).not.toBe(0)
		expect(result.stdout).toBe('')
		expect(result.stderr).toContain(cwd === '/missing' ? 'No such file or directory' : 'Not a directory')
		expect(result.timedOut).toBe(false)
		expect(ws.filesystem.exists('/prev/wrong.txt')).toBe(false)
		expect(ws.filesystem.exists('/before.txt')).toBe(false)
		expect(ws.filesystem.exists('/after.txt')).toBe(false)
		expect(new TextDecoder().decode(ws.filesystem.readFile('/regular-file'))).toBe('original')
	}

	expect((await runner.run({ command: 'pwd', cwd: '/prev', timeoutMs: 1 })).stdout).toBe('/prev\n')
})

test.each([false, true])('supports quoted space-containing cwd with directory symlink: %s', async (symlink) => {
	const ws = workspace()
	const directory = "/one's workspace"
	ws.filesystem.mkdir(directory, { recursive: true })
	const cwd = symlink ? "/linked workspace's" : directory
	if (symlink) ws.filesystem.symlink(directory, cwd)
	const runner = createKompjutrShellRunner({ filesystem: ws.filesystem })

	const result = await runner.run({
		command: 'cat > "quoted file.txt"; printf "%s" "$VALUE" >> "quoted file.txt"; cat "quoted file.txt"',
		cwd,
		env: { VALUE: "-env 'quoted' $literal; value" },
		stdin: "stdin 'quoted' $literal; value",
		timeoutMs: 1,
	})

	const expected = "stdin 'quoted' $literal; value-env 'quoted' $literal; value"
	expect(result).toMatchObject({ stdout: expected, stderr: '', exitCode: 0, timedOut: false })
	expect(new TextDecoder().decode(ws.filesystem.readFile(`${directory}/quoted file.txt`))).toBe(expected)
})

test('rejects path grants it cannot enforce', async () => {
	const ws = workspace()
	const runner = createKompjutrShellRunner({ filesystem: ws.filesystem })

	await expect(
		runner.run({
			command: 'true',
			cwd: '/',
			grants: [{ path: '/', mode: 'rw' }],
			timeoutMs: 10_000,
		}),
	).rejects.toThrow('does not support path grants')
})
