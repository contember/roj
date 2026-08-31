import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBunShellRunner } from '~/bun-platform/shell.js'
import type { SessionEnvironment } from '~/core/sessions/session-environment.js'
import type { ShellConfinement, ShellRunner, ShellRunOptions } from '~/platform/shell.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { type ShellConfig, ShellExecutor } from './executor.js'

const testPlatform = createNodePlatform()
const testExecutorDeps = { fs: testPlatform.fs, shell: createBunShellRunner() }

// ============================================================================
// Test Helpers
// ============================================================================

const defaultConfig: ShellConfig = {
	cwd: process.cwd(),
	timeout: 5000,
	sandboxed: false,
	sandbox: { enabled: false },
}

const sandboxedConfig: ShellConfig = {
	cwd: '/tmp',
	timeout: 5000,
	sandboxed: true,
	sandbox: { enabled: true },
}

const createTestEnvironment = (): SessionEnvironment => ({
	sessionDir: '/tmp/test-session',
	sandboxed: false,
})

/** A runner that records what the executor asked for and answers without running anything. */
function recordingRunner(confinement: ShellConfinement): { runner: ShellRunner; calls: ShellRunOptions[] } {
	const calls: ShellRunOptions[] = []
	return {
		calls,
		runner: {
			confinement,
			run: async (options) => {
				calls.push(options)
				return { stdout: 'recorded', stderr: '', exitCode: 0, timedOut: false }
			},
		},
	}
}

// ============================================================================
// ShellExecutor Tests
// ============================================================================

describe('ShellExecutor', () => {
	it('executes simple echo command', async () => {
		const executor = new ShellExecutor(defaultConfig, testExecutorDeps)
		const environment = createTestEnvironment()

		const result = await executor.execute(
			{ command: "echo 'Hello, World!'" },
			environment,
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.stdout).toBe('Hello, World!')
		expect(result.value.stderr).toBe('')
		expect(result.value.exitCode).toBe(0)
		expect(result.value.timedOut).toBe(false)
		expect(result.value.durationMs).toBeGreaterThan(0)
	})

	it('returns stderr for errors', async () => {
		const executor = new ShellExecutor(defaultConfig, testExecutorDeps)
		const environment = createTestEnvironment()

		const result = await executor.execute(
			{ command: 'ls /nonexistent_directory_12345' },
			environment,
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.exitCode).not.toBe(0)
		expect(result.value.stderr).toContain('No such file or directory')
	})

	it('handles command with args array', async () => {
		const executor = new ShellExecutor(defaultConfig, testExecutorDeps)
		const environment = createTestEnvironment()

		const result = await executor.execute(
			{ command: 'echo', args: ['arg1', 'arg2', 'arg3'] },
			environment,
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.stdout).toBe('arg1 arg2 arg3')
		expect(result.value.exitCode).toBe(0)
	})

	it('supports stdin input', async () => {
		const executor = new ShellExecutor(defaultConfig, testExecutorDeps)
		const environment = createTestEnvironment()

		const result = await executor.execute(
			{ command: 'cat', stdin: 'Hello from stdin' },
			environment,
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.stdout).toBe('Hello from stdin')
		expect(result.value.exitCode).toBe(0)
	})

	it(
		'times out long-running commands',
		async () => {
			const executor = new ShellExecutor({ ...defaultConfig, timeout: 200 }, testExecutorDeps)
			const environment = createTestEnvironment()

			const result = await executor.execute({ command: 'sleep 10' }, environment)

			expect(result.ok).toBe(true)
			if (!result.ok) return

			expect(result.value.timedOut).toBe(true)
			expect(result.value.signal).toBeDefined()
		},
		{ timeout: 10000 },
	)

	it(
		'allows overriding timeout per-command',
		async () => {
			const executor = new ShellExecutor({ ...defaultConfig, timeout: 10000 }, testExecutorDeps)
			const environment = createTestEnvironment()

			const result = await executor.execute(
				{ command: 'sleep 10', timeout: 200 },
				environment,
			)

			expect(result.ok).toBe(true)
			if (!result.ok) return

			expect(result.value.timedOut).toBe(true)
		},
		{ timeout: 10000 },
	)

	it('collects large stdout without truncation', async () => {
		const executor = new ShellExecutor(defaultConfig, testExecutorDeps)
		const environment = createTestEnvironment()

		// Generate large output - shell tool no longer truncates, eviction happens at agent level
		const result = await executor.execute(
			{ command: "yes 'test' | head -n 1000" },
			environment,
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.stdout.split('\n').length).toBe(1000)
	})

	it('uses custom working directory', async () => {
		const executor = new ShellExecutor(defaultConfig, testExecutorDeps)
		const environment = createTestEnvironment()

		const result = await executor.execute({ command: 'pwd', cwd: '/tmp' }, environment)

		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.stdout).toMatch(/^(\/private)?\/tmp$/)
	})

	it('passes environment variables', async () => {
		const executor = new ShellExecutor({
			...defaultConfig,
			env: { TEST_VAR: 'test_value' },
		}, testExecutorDeps)
		const environment = createTestEnvironment()

		const result = await executor.execute(
			{ command: 'echo $TEST_VAR' },
			environment,
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.stdout).toBe('test_value')
	})

	it('returns non-zero exit code for failing commands', async () => {
		const executor = new ShellExecutor(defaultConfig, testExecutorDeps)
		const environment = createTestEnvironment()

		const result = await executor.execute({ command: 'exit 42' }, environment)

		expect(result.ok).toBe(true)
		if (!result.ok) return

		expect(result.value.exitCode).toBe(42)
	})

	it('fails clearly when the host has no shell', async () => {
		const executor = new ShellExecutor(defaultConfig, { fs: testPlatform.fs })

		const result = await executor.execute({ command: 'echo hi' }, createTestEnvironment())

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toContain('no shell')
		expect(result.error.recoverable).toBe(false)
	})

	it('refuses to run a sandboxed command on a shell that cannot confine', async () => {
		const { runner, calls } = recordingRunner('none')
		const executor = new ShellExecutor(sandboxedConfig, { fs: testPlatform.fs, shell: runner })

		const result = await executor.execute({ command: 'echo hi' }, { sessionDir: '/tmp', sandboxed: true })

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toContain('cannot confine')
		expect(calls).toEqual([])
	})

	it('runs unconfined commands on a shell that cannot confine', async () => {
		const { runner, calls } = recordingRunner('none')
		const executor = new ShellExecutor(defaultConfig, { fs: testPlatform.fs, shell: runner })

		const result = await executor.execute({ command: 'echo hi' }, createTestEnvironment())

		expect(result.ok).toBe(true)
		expect(calls.length).toBe(1)
	})

	it('accepts a host-confined shell for a sandboxed session and grants it nothing', async () => {
		const { runner, calls } = recordingRunner('host')
		const executor = new ShellExecutor(sandboxedConfig, { fs: testPlatform.fs, shell: runner })

		const result = await executor.execute({ command: 'echo hi' }, { sessionDir: '/tmp', sandboxed: true })

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.value.stdout).toBe('recorded')
		expect(calls[0].cwd).toBe('/home/user/session')
		expect(calls[0].grants).toBeUndefined()
	})

	it('grants a path-confined shell the session under its agent-visible name', async () => {
		const { runner, calls } = recordingRunner('paths')
		const executor = new ShellExecutor({
			...sandboxedConfig,
			extraBinds: [{ path: '/tmp/project', mode: 'rw' }, { path: '/tmp/shared', mode: 'ro' }],
			sandbox: { enabled: true, network: true },
		}, { fs: testPlatform.fs, shell: runner })

		const result = await executor.execute(
			{ command: 'echo hi' },
			{ sessionDir: '/tmp', workspaceDir: '/tmp', sandboxed: true },
		)

		expect(result.ok).toBe(true)
		expect(calls[0].grants).toEqual([
			{ path: '/home/user/session', source: '/tmp', mode: 'rw' },
			{ path: '/home/user/workspace', source: '/tmp', mode: 'rw' },
			{ path: '/tmp/project', source: '/tmp/project', mode: 'rw' },
			{ path: '/tmp/shared', source: '/tmp/shared', mode: 'ro' },
		])
		expect(calls[0].network).toBe(true)
	})

	it('keeps a read-only bind ahead of a legacy writable path that would widen it', async () => {
		const { runner, calls } = recordingRunner('paths')
		const executor = new ShellExecutor({
			...sandboxedConfig,
			extraBinds: [{ path: '/tmp/secret', mode: 'ro' }],
			sandbox: { enabled: true, writablePaths: ['/tmp/secret'] },
		}, { fs: testPlatform.fs, shell: runner })

		const result = await executor.execute({ command: 'echo hi' }, { sessionDir: '/tmp', sandboxed: true })

		expect(result.ok).toBe(true)
		expect(calls[0].grants).toEqual([
			{ path: '/home/user/session', source: '/tmp', mode: 'rw' },
			{ path: '/tmp/secret', source: '/tmp/secret', mode: 'ro' },
			{ path: '/tmp/secret', mode: 'rw' },
		])
	})

	describe('sandbox cwd containment', () => {
		let root = ''
		let sessionDir = ''
		let projectDir = ''

		const containedConfig = (): ShellConfig => ({
			...sandboxedConfig,
			extraBinds: [{ path: projectDir, mode: 'rw', destPath: '/home/user/project' }],
		})
		const environment = (): SessionEnvironment => ({ sessionDir, sandboxed: true })

		beforeAll(async () => {
			root = await mkdtemp(join(tmpdir(), 'roj-cwd-'))
			sessionDir = join(root, 'session')
			projectDir = join(root, 'project')
			await mkdir(join(sessionDir, 'nested', 'dir'), { recursive: true })
			await mkdir(join(projectDir, 'sub'), { recursive: true })
			// Exists on the host, so only the root boundary — not a missing directory — can reject it.
			await mkdir(`${projectDir}-evil`, { recursive: true })
			await symlink('/', join(projectDir, 'to-root'))
		})

		afterAll(async () => {
			await rm(root, { recursive: true, force: true })
		})

		it('passes a contained working directory on, normalized', async () => {
			const { runner, calls } = recordingRunner('paths')
			const executor = new ShellExecutor(containedConfig(), { fs: testPlatform.fs, shell: runner })

			const result = await executor.execute({ command: 'pwd', cwd: '/home/user/session/nested/./dir' }, environment())

			expect(result.ok).toBe(true)
			expect(calls[0].cwd).toBe('/home/user/session/nested/dir')
		})

		it('refuses a relative working directory instead of resolving it against the host process', async () => {
			const { runner, calls } = recordingRunner('paths')
			const executor = new ShellExecutor(containedConfig(), { fs: testPlatform.fs, shell: runner })

			for (const cwd of ['build', '.', '', '~']) {
				const result = await executor.execute({ command: 'pwd', cwd }, environment())

				expect(result.ok).toBe(false)
				if (!result.ok) expect(result.error.message).toContain('must be an absolute path')
			}
			expect(calls).toHaveLength(0)
		})

		it('accepts a working directory that only normalization places in the session', async () => {
			const { runner, calls } = recordingRunner('paths')
			const executor = new ShellExecutor(containedConfig(), { fs: testPlatform.fs, shell: runner })

			const result = await executor.execute({ command: 'pwd', cwd: '/home/user/./session/nested' }, environment())

			expect(result.ok).toBe(true)
			expect(calls[0].cwd).toBe('/home/user/session/nested')
		})

		it('accepts a working directory the extra binds mount', async () => {
			const { runner, calls } = recordingRunner('paths')
			const executor = new ShellExecutor(containedConfig(), { fs: testPlatform.fs, shell: runner })

			const result = await executor.execute({ command: 'git status', cwd: '/home/user/project/sub' }, environment())

			expect(result.ok).toBe(true)
			expect(calls[0].cwd).toBe('/home/user/project/sub')
		})

		it('rejects a symlink inside a bind that points out of it', async () => {
			const { runner, calls } = recordingRunner('paths')
			const executor = new ShellExecutor(containedConfig(), { fs: testPlatform.fs, shell: runner })

			const result = await executor.execute({ command: 'pwd -P', cwd: '/home/user/project/to-root' }, environment())

			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.error.message).toContain('via symlink')
			expect(calls).toEqual([])
		})

		it('rejects a sibling that only shares a bind root prefix', async () => {
			const { runner, calls } = recordingRunner('paths')
			const executor = new ShellExecutor(containedConfig(), { fs: testPlatform.fs, shell: runner })

			const result = await executor.execute({ command: 'ls', cwd: '/home/user/project-evil' }, environment())

			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.error.message).toContain('not mounted in this sandbox')
			expect(calls).toEqual([])
		})

		it('rejects a home path the sandbox does not mount, and says what it does', async () => {
			const { runner, calls } = recordingRunner('paths')
			const executor = new ShellExecutor(containedConfig(), { fs: testPlatform.fs, shell: runner })

			const result = await executor.execute({ command: 'ls', cwd: '/home/user/elsewhere' }, environment())

			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.error.message).toContain('not mounted in this sandbox')
			expect(result.error.message).toContain('/home/user/session')
			expect(result.error.message).toContain('/home/user/project')
			expect(calls).toEqual([])
		})

		it('keeps the read-only tree and the scratch tmpfs available', async () => {
			const { runner, calls } = recordingRunner('paths')
			const executor = new ShellExecutor(containedConfig(), { fs: testPlatform.fs, shell: runner })

			const scratch = await executor.execute({ command: 'ls', cwd: '/tmp' }, environment())
			const readOnly = await executor.execute({ command: 'ls', cwd: '/usr/share' }, environment())

			expect(scratch.ok).toBe(true)
			expect(readOnly.ok).toBe(true)
			expect(calls.map((call) => call.cwd)).toEqual(['/tmp', '/usr/share'])
		})

		it('rejects a working directory that does not exist, before the host does', async () => {
			const { runner, calls } = recordingRunner('paths')
			const executor = new ShellExecutor(containedConfig(), { fs: testPlatform.fs, shell: runner })

			const result = await executor.execute({ command: 'ls', cwd: '/home/user/session/nope' }, environment())

			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.error.message).toContain('does not exist')
			expect(calls).toEqual([])
		})

		it('rejects a workspace working directory when the session has no workspace', async () => {
			const { runner, calls } = recordingRunner('paths')
			const executor = new ShellExecutor(containedConfig(), { fs: testPlatform.fs, shell: runner })

			const result = await executor.execute({ command: 'pwd', cwd: '/home/user/workspace/app' }, environment())

			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.error.message).toContain('No workspace directory')
			expect(calls).toEqual([])
		})
	})

	it('reports a run the host could not start', async () => {
		const runner: ShellRunner = {
			confinement: 'paths',
			run: async () => {
				throw new Error('Failed to execute command: bwrap missing')
			},
		}
		const executor = new ShellExecutor(defaultConfig, { fs: testPlatform.fs, shell: runner })

		const result = await executor.execute({ command: 'echo hi' }, createTestEnvironment())

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toBe('Failed to execute command: bwrap missing')
		expect(result.error.details).toEqual({ durationMs: expect.any(Number) })
	})
})
