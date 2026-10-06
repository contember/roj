import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBunPlatform } from '../../bun-platform/index.js'
import { SessionFileStore } from '../../core/file-store/file-store.js'
import { ShellExecutor, type RunCommandInput } from './executor.js'

const SESSION = '/home/user/session'
const WORKSPACE = '/home/user/workspace'
const READONLY = '/home/user/reference'

function sandboxUsable(): boolean {
	try {
		return Bun.spawnSync(['bwrap', '--dev-bind', '/', '/', '--unshare-all', 'true']).success
	} catch {
		return false
	}
}

const usable = sandboxUsable()
const required = process.env.ROJ_REQUIRE_SANDBOX === '1'
const runIt = it.skipIf(!usable && !required)

async function createFixture() {
	expect(usable).toBe(true)
	const root = await mkdtemp(join(tmpdir(), 'roj-sandbox-namespace-'))
	try {
		await Promise.all(['session/sub', 'workspace/sub', 'readonly', 'outside'].map((path) => mkdir(join(root, path), { recursive: true })))
		const platform = createBunPlatform()
		const environment = {
			sessionDir: join(root, 'session'),
			workspaceDir: join(root, 'workspace'),
			sandboxed: true,
		}
		const fileStore = new SessionFileStore(environment.sessionDir, environment.workspaceDir, true, platform.fs)
		const executor = new ShellExecutor(
			{
				cwd: environment.sessionDir,
				sandboxed: true,
				timeout: 5000,
				extraBinds: [{ path: join(root, 'readonly'), destPath: READONLY, mode: 'ro' }],
			},
			platform,
		)
		return {
			root,
			fileStore,
			execute: (input: RunCommandInput) => executor.execute(input, environment),
			async run(input: RunCommandInput) {
				const result = await executor.execute(input, environment)
				if (!result.ok) throw new Error(result.error.message)
				return result.value
			},
			cleanup: () => rm(root, { recursive: true, force: true }),
		}
	} catch (error) {
		await rm(root, { recursive: true, force: true })
		throw error
	}
}

describe('Bun sandbox virtual namespace compatibility', () => {
	runIt('round-trips FileStore paths through shell reads and redirects in both virtual roots', async () => {
		const fixture = await createFixture()
		try {
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
					stdout: `${virtualRoot}/sub\nfrom file store`,
				})
				expect(await fixture.fileStore.read(`${virtualRoot}/sub/output.txt`)).toEqual({ ok: true, value: 'from file store\n' })
			}
			expect(await fixture.run({ command: 'pwd' })).toMatchObject({
				exitCode: 0,
				stdout: SESSION,
			})
		} finally {
			await fixture.cleanup()
		}
	})

	runIt('enforces a remapped read-only bind and denies outside traversal and symlinks', async () => {
		const fixture = await createFixture()
		try {
			const reference = join(fixture.root, 'readonly', 'marker.txt')
			const outside = join(fixture.root, 'outside', 'marker.txt')
			await writeFile(reference, 'reference\n')
			await writeFile(outside, 'outside\n')
			await symlink(join(fixture.root, 'outside'), join(fixture.root, 'session', 'escape'))
			expect(await fixture.run({ command: `cat ${READONLY}/marker.txt` })).toMatchObject({ exitCode: 0, stdout: 'reference' })
			const readonlyWrite = await fixture.run({
				command: `printf changed > ${READONLY}/marker.txt`,
			})
			expect(readonlyWrite.timedOut).toBe(false)
			expect(readonlyWrite.exitCode).not.toBe(0)
			expect(await readFile(reference, 'utf8')).toBe('reference\n')

			for (const path of [`${SESSION}/../outside`, `${SESSION}/escape`]) {
				expect(
					(
						await fixture.execute({
							command: 'printf changed > marker.txt',
							cwd: path,
						})
					).ok,
				).toBe(false)
				expect((await fixture.fileStore.write(`${path}/marker.txt`, 'changed')).ok).toBe(false)
				expect((await fixture.fileStore.read(`${path}/marker.txt`)).ok).toBe(false)
			}
			// Command text bypasses cwd validation; these failures must come from the real namespace.
			for (const path of [`${SESSION}/../../..${outside}`, `${SESSION}/escape/marker.txt`]) {
				const read = await fixture.run({ command: `cat '${path}'` })
				expect(read.exitCode).not.toBe(0)
				expect(read.stdout).toBe('')
				const write = await fixture.run({
					command: `printf changed > '${path}'`,
				})
				expect(write.timedOut).toBe(false)
				expect(write.exitCode).not.toBe(0)
				expect(await readFile(outside, 'utf8')).toBe('outside\n')
			}
		} finally {
			await fixture.cleanup()
		}
	})

	runIt(
		'stops a delayed descendant from mutating a FileStore marker after timeout returns',
		async () => {
			const fixture = await createFixture()
			try {
				const marker = await fixture.fileStore.write(`${SESSION}/marker.txt`, 'unchanged\n')
				if (!marker.ok) throw new Error(marker.error)
				const result = await fixture.run({
					command: `(sleep 2; printf changed > '${marker.value.path}') </dev/null >/dev/null 2>&1 & echo ready; wait`,
					timeout: 500,
				})
				expect(result.timedOut).toBe(true)
				expect(result.stdout).toBe('ready')
				expect(await fixture.fileStore.read(marker.value.path)).toEqual({
					ok: true,
					value: 'unchanged\n',
				})
				await Bun.sleep(2200)
				expect(await fixture.fileStore.read(marker.value.path)).toEqual({
					ok: true,
					value: 'unchanged\n',
				})
			} finally {
				await fixture.cleanup()
			}
		},
		15_000,
	)
})
