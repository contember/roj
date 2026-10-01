import { expect, test } from 'bun:test'
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
