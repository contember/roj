/**
 * The SDK's sandbox namespace checks, run through the shell executor against a
 * kompjutr workspace with paths confinement. Mirrors the Bun sandbox's
 * `sandbox-namespace.integration.test.ts`; the timeout case does not apply,
 * because this shell has no timeout.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createGit, Workspace } from '@kompjutr/do'
import { SessionFileStore } from '../../sdk/src/core/file-store/file-store.js'
import { type RunCommandInput, ShellExecutor } from '../../sdk/src/plugins/shell/executor.js'
import { createKompjutrPlatform } from './index.js'
import { BunSqliteStorage } from './testing/storage.js'

const SESSION = '/home/user/session'
const WORKSPACE = '/home/user/workspace'
const READONLY = '/home/user/reference'
const ROOT = '/fixture'

const storages: BunSqliteStorage[] = []

afterEach(() => {
	for (const storage of storages.splice(0)) storage.close()
})

function createFixture() {
	const storage = new BunSqliteStorage()
	storages.push(storage)
	const workspace = new Workspace({
		storage,
		git: createGit(),
		defaultGitIdentity: { name: 'Roj', email: 'roj@example.com' },
	})
	for (const path of ['session/sub', 'workspace/sub', 'readonly', 'outside']) {
		workspace.filesystem.mkdir(`${ROOT}/${path}`, { recursive: true })
	}
	const platform = createKompjutrPlatform(workspace, { shellConfinement: 'paths' })
	const environment = {
		sessionDir: `${ROOT}/session`,
		workspaceDir: `${ROOT}/workspace`,
		sandboxed: true,
	}
	const fileStore = new SessionFileStore(environment.sessionDir, environment.workspaceDir, true, platform.fs)
	const executor = new ShellExecutor(
		{
			cwd: environment.sessionDir,
			sandboxed: true,
			timeout: 5000,
			extraBinds: [{ path: `${ROOT}/readonly`, destPath: READONLY, mode: 'ro' }],
		},
		platform,
	)
	return {
		filesystem: workspace.filesystem,
		fileStore,
		execute: (input: RunCommandInput) => executor.execute(input, environment),
		async run(input: RunCommandInput) {
			const result = await executor.execute(input, environment)
			if (!result.ok) throw new Error(result.error.message)
			return result.value
		},
		read: (path: string) => new TextDecoder().decode(workspace.filesystem.readFile(path)),
	}
}

describe('kompjutr paths confinement virtual namespace compatibility', () => {
	it('round-trips FileStore paths through shell reads and redirects in both virtual roots', async () => {
		const fixture = createFixture()
		for (const virtualRoot of [SESSION, WORKSPACE]) {
			const written = await fixture.fileStore.write(`${virtualRoot}/sub/input.txt`, 'from file store\n')
			if (!written.ok) throw new Error(written.error)
			expect(written.value.path).toBe(`${virtualRoot}/sub/input.txt`)
			const result = await fixture.run({
				command: `pwd && cat '${written.value.path}' > output.txt && cat output.txt`,
				cwd: `${virtualRoot}/sub`,
			})
			expect(result).toMatchObject({
				exitCode: 0,
				timedOut: false,
				stderr: '',
				stdout: `${virtualRoot}/sub\nfrom file store\n`,
			})
			expect(await fixture.fileStore.read(`${virtualRoot}/sub/output.txt`)).toEqual({ ok: true, value: 'from file store\n' })
		}
		expect(await fixture.run({ command: 'pwd' })).toMatchObject({
			exitCode: 0,
			stdout: `${SESSION}\n`,
		})
	})

	it('enforces a remapped read-only bind and denies outside traversal and symlinks', async () => {
		const fixture = createFixture()
		const outside = `${ROOT}/outside/marker.txt`
		fixture.filesystem.writeFile(`${ROOT}/readonly/marker.txt`, new TextEncoder().encode('reference\n'))
		fixture.filesystem.writeFile(outside, new TextEncoder().encode('outside\n'))
		fixture.filesystem.symlink(`${ROOT}/outside`, `${ROOT}/session/escape`)

		expect(await fixture.run({ command: `cat ${READONLY}/marker.txt` })).toMatchObject({ exitCode: 0, stdout: 'reference\n' })
		const readonlyWrite = await fixture.run({ command: `printf changed > ${READONLY}/marker.txt` })
		expect(readonlyWrite.exitCode).not.toBe(0)
		expect(fixture.read(`${ROOT}/readonly/marker.txt`)).toBe('reference\n')

		for (const path of [`${SESSION}/../outside`, `${SESSION}/escape`]) {
			expect((await fixture.execute({ command: 'printf changed > marker.txt', cwd: path })).ok).toBe(false)
			expect((await fixture.fileStore.write(`${path}/marker.txt`, 'changed')).ok).toBe(false)
			expect((await fixture.fileStore.read(`${path}/marker.txt`)).ok).toBe(false)
		}
		// Command text bypasses cwd validation; these failures must come from the mounted view.
		for (const path of [`${SESSION}/../../..${outside}`, `${SESSION}/escape/marker.txt`, outside]) {
			const read = await fixture.run({ command: `cat '${path}'` })
			expect(read.exitCode).not.toBe(0)
			expect(read.stdout).toBe('')
			const write = await fixture.run({ command: `printf changed > '${path}'` })
			expect(write.exitCode).not.toBe(0)
			expect(fixture.read(outside)).toBe('outside\n')
		}
	})
})
