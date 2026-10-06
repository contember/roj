import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ShellConfinement, ShellRunner, ShellRunOptions, ShellRunResult } from '~/platform/shell.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { ShellExecutor } from './executor.js'

const fs = createNodePlatform().fs

describe('legacy shell runner compatibility', () => {
	let root = ''
	beforeAll(async () => {
		root = await mkdtemp('/tmp/roj-shell-compatibility-')
		await Promise.all(['session/sub', 'workspace/sub', 'readonly/sub'].map((path) => mkdir(join(root, path), { recursive: true })))
	})
	afterAll(async () => {
		await rm(root, { recursive: true, force: true })
	})

	const confinements: ShellConfinement[] = ['paths', 'host']
	for (const confinement of confinements) {
		test(`${confinement} keeps its cwd namespace and forwards legacy timeout, binds and command options`, async () => {
			const calls: ShellRunOptions[] = []
			const runner: ShellRunner = {
				confinement,
				async run(options) {
					calls.push(options)
					return { stdout: '', stderr: '', exitCode: 143, timedOut: true, signal: 'SIGTERM' }
				},
			}
			const executor = new ShellExecutor(
				{
					cwd: root,
					sandboxed: true,
					timeout: 1200,
					env: { COMPAT: 'value' },
					extraBinds: [{ path: join(root, 'readonly'), destPath: '/home/user/readonly', mode: 'ro' }],
					sandbox: { enabled: true, network: true, limits: { processes: 256, fileSizeBytes: null } },
				},
				{ fs, shell: runner },
			)
			const environment = { sessionDir: join(root, 'session'), workspaceDir: join(root, 'workspace'), sandboxed: true }
			for (const directory of ['session', 'workspace', 'readonly']) {
				const result = await executor.execute({ command: 'cat', cwd: `/home/user/${directory}/sub`, stdin: 'input', timeout: 300 }, environment)
				expect(result.ok).toBe(true)
				if (!result.ok) throw new Error(result.error.message)
				expect(result.value).toMatchObject({ exitCode: 143, timedOut: true, signal: 'SIGTERM' })
				expect(result.value).not.toHaveProperty('truncated')
			}
			expect(calls.map((call) => call.cwd)).toEqual(
				['session', 'workspace', 'readonly'].map((directory) => (confinement === 'paths' ? `/home/user/${directory}/sub` : join(root, directory, 'sub'))),
			)
			for (const call of calls) {
				expect(call).toMatchObject({ command: 'cat', stdin: 'input', timeoutMs: 300, env: { COMPAT: 'value' } })
				if (confinement === 'paths') {
					expect(call.grants).toEqual([
						{ path: '/home/user/session', source: environment.sessionDir, mode: 'rw' },
						{ path: '/home/user/workspace', source: environment.workspaceDir, mode: 'rw' },
						{ path: '/home/user/readonly', source: join(root, 'readonly'), mode: 'ro' },
					])
					expect(call.network).toBe(true)
					expect(call.limits).toEqual({ processes: 256, fileSizeBytes: null })
				} else {
					expect(call).not.toHaveProperty('grants')
					expect(call).not.toHaveProperty('network')
					expect(call).not.toHaveProperty('limits')
				}
			}
			await executor.execute({ command: 'pwd' }, environment)
			expect(calls[3].timeoutMs).toBe(1200)
			expect(calls[3].cwd).toBe(confinement === 'paths' ? '/home/user/session' : environment.sessionDir)
		})
	}

	for (const truncated of [undefined, false, true]) {
		test(`preserves output truncation metadata ${truncated}`, async () => {
			const response: ShellRunResult = { stdout: 'output', stderr: '', exitCode: 0, timedOut: false }
			if (truncated !== undefined) response.truncated = truncated
			const runner: ShellRunner = { confinement: 'none', run: async () => response }
			const executor = new ShellExecutor({ cwd: root, sandboxed: false }, { fs, shell: runner })
			const result = await executor.execute({ command: 'echo output' }, { sessionDir: root, sandboxed: false })
			expect(result.ok).toBe(true)
			if (!result.ok) throw new Error(result.error.message)
			if (truncated === undefined) {
				expect(result.value).not.toHaveProperty('truncated')
				expect(JSON.stringify(result.value)).not.toContain('truncated')
			} else {
				expect(result.value.truncated).toBe(truncated)
				expect(JSON.stringify(result.value)).toContain(`"truncated":${truncated}`)
			}
		})
	}
})
