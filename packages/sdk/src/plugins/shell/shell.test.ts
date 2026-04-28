import { describe, expect, it } from 'bun:test'
import type { SessionEnvironment } from '~/core/sessions/session-environment.js'
import { createNodePlatform } from '~/testing/node-platform.js'
import { buildBwrapArgs, type ShellConfig, ShellExecutor } from './executor.js'

const testPlatform = createNodePlatform()
const testExecutorDeps = { fs: testPlatform.fs, process: testPlatform.process }

// ============================================================================
// Test Helpers
// ============================================================================

const defaultConfig: ShellConfig = {
	cwd: process.cwd(),
	timeout: 5000,
	sandboxed: false,
	sandbox: { enabled: false },
}

const createTestEnvironment = (): SessionEnvironment => ({
	sessionDir: '/tmp/test-session',
	sandboxed: false,
})

// ============================================================================
// buildBwrapArgs Tests
// ============================================================================

describe('buildBwrapArgs', () => {
	it('builds basic args with session dir mapping', () => {
		const args = buildBwrapArgs({
			command: 'echo hello',
			cwd: '/home/user/session',
			sandbox: { enabled: true },
			sessionDir: '/real/session/path',
		})

		expect(args).toContain('--ro-bind')
		expect(args).toContain('--dev')
		expect(args).toContain('--proc')
		expect(args).toContain('--tmpfs')
		expect(args).toContain('--unshare-all')
		expect(args).toContain('--die-with-parent')
		// Session dir should be mapped
		const bindIdx = args.indexOf('--bind')
		expect(args[bindIdx + 1]).toBe('/real/session/path')
		expect(args[bindIdx + 2]).toBe('/home/user/session')
		// No --share-net by default
		expect(args).not.toContain('--share-net')
		// --chdir sets working directory inside namespace
		const chdirIdx = args.indexOf('--chdir')
		expect(chdirIdx).toBeGreaterThan(0)
		expect(args[chdirIdx + 1]).toBe('/home/user/session')
		// Command at the end
		expect(args.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hello'])
	})

	it('includes --share-net when network enabled', () => {
		const args = buildBwrapArgs({
			command: 'curl example.com',
			cwd: '/home/user/session',
			sandbox: { enabled: true, network: true },
			sessionDir: '/tmp/session',
		})

		expect(args).toContain('--share-net')
	})

	it('maps both session and workspace dirs', () => {
		const args = buildBwrapArgs({
			command: 'ls',
			cwd: '/home/user/session',
			sandbox: { enabled: true },
			sessionDir: '/real/session',
			workspaceDir: '/real/workspace',
		})

		const bindIndices: number[] = []
		args.forEach((a, i) => {
			if (a === '--bind') bindIndices.push(i)
		})
		expect(bindIndices.length).toBe(2) // session + workspace

		// Verify session mapping
		expect(args[bindIndices[0] + 1]).toBe('/real/session')
		expect(args[bindIndices[0] + 2]).toBe('/home/user/session')

		// Verify workspace mapping
		expect(args[bindIndices[1] + 1]).toBe('/real/workspace')
		expect(args[bindIndices[1] + 2]).toBe('/home/user/workspace')
	})

	it('adds extra bind mounts with correct mode', () => {
		const args = buildBwrapArgs({
			command: 'git status',
			cwd: '/home/user/session',
			sandbox: { enabled: true },
			sessionDir: '/real/session',
			extraBinds: [
				{ path: '/home/user/project', mode: 'rw' },
				{ path: '/opt/shared', mode: 'ro' },
			],
		})

		// rw bind: --bind path path
		const rwIdx = args.indexOf('/home/user/project')
		expect(rwIdx).toBeGreaterThan(0)
		expect(args[rwIdx - 1]).toBe('--bind')
		expect(args[rwIdx + 1]).toBe('/home/user/project')

		// ro bind: --ro-bind path path
		const roIdx = args.indexOf('/opt/shared')
		expect(roIdx).toBeGreaterThan(0)
		expect(args[roIdx - 1]).toBe('--ro-bind')
		expect(args[roIdx + 1]).toBe('/opt/shared')
	})

	it('sets --chdir to workspace cwd', () => {
		const args = buildBwrapArgs({
			command: 'git status',
			cwd: '/home/user/workspace',
			sandbox: { enabled: true },
			sessionDir: '/real/session',
			workspaceDir: '/real/workspace',
		})

		const chdirIdx = args.indexOf('--chdir')
		expect(chdirIdx).toBeGreaterThan(0)
		expect(args[chdirIdx + 1]).toBe('/home/user/workspace')
	})

	it('falls back to cwd writable when no session/workspace dirs', () => {
		const args = buildBwrapArgs({
			command: 'ls',
			cwd: '/home/user',
			sandbox: { enabled: true },
		})

		const bindIndices: number[] = []
		args.forEach((a, i) => {
			if (a === '--bind') bindIndices.push(i)
		})
		expect(bindIndices.length).toBe(1)
		expect(args[bindIndices[0] + 1]).toBe('/home/user')
		expect(args[bindIndices[0] + 2]).toBe('/home/user')
	})
})

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
})
