import { describe, expect, it } from 'bun:test'
import { ChildProcess } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import type { SessionEnvironment } from '~/core/sessions/session-environment.js'
import type { ExecFileResult, ProcessRunner } from '~/platform/process.js'
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

	it('returns an error when stdin delivery fails before a zero exit', async () => {
		const stdin = new Writable({
			write(_chunk, _encoding, callback) {
				const error = new Error('broken pipe')
				Object.defineProperty(error, 'code', { value: 'EPIPE' })
				callback(error)
			},
		})
		const child = new ChildProcess()
		Object.defineProperties(child, {
			pid: { value: 424_243 },
			stdin: { value: stdin },
			stdout: { value: null },
			stderr: { value: null },
		})
		const processRunner: ProcessRunner = {
			spawn: () => {
				setTimeout(() => child.emit('close', 0, null), 0)
				return child
			},
			execFile: async (): Promise<ExecFileResult> => {
				throw new Error('Unexpected execFile call')
			},
		}
		const executor = new ShellExecutor(defaultConfig, {
			fs: testPlatform.fs,
			process: processRunner,
		})

		const result = await executor.execute(
			{ command: 'ignores-stdin', stdin: 'data after exit' },
			createTestEnvironment(),
		)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toContain('Failed to deliver command stdin')
		expect(result.error.message).toContain('broken pipe')
		expect(result.error.details).toEqual(expect.objectContaining({ exitCode: 0 }))
	})

	it('returns success when stdin delivery finishes before a zero exit', async () => {
		let written = ''
		const stdin = new Writable({
			write(chunk, _encoding, callback) {
				written += chunk.toString()
				callback()
			},
		})
		const child = new ChildProcess()
		Object.defineProperties(child, {
			pid: { value: 424_244 },
			stdin: { value: stdin },
			stdout: { value: null },
			stderr: { value: null },
		})
		const processRunner: ProcessRunner = {
			spawn: () => {
				setTimeout(() => child.emit('close', 0, null), 0)
				return child
			},
			execFile: async (): Promise<ExecFileResult> => {
				throw new Error('Unexpected execFile call')
			},
		}
		const executor = new ShellExecutor(defaultConfig, {
			fs: testPlatform.fs,
			process: processRunner,
		})

		const result = await executor.execute(
			{ command: 'reads-stdin', stdin: 'delivered input' },
			createTestEnvironment(),
		)

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.value.exitCode).toBe(0)
		expect(written).toBe('delivered input')
	})

	it('gives stdin delivery failure precedence over a nonzero exit', async () => {
		const stdout = new PassThrough()
		const stderr = new PassThrough()
		const stdin = new Writable({
			write(_chunk, _encoding, callback) {
				callback(new Error('stdin rejected'))
			},
		})
		const child = new ChildProcess()
		Object.defineProperties(child, {
			pid: { value: 424_245 },
			stdin: { value: stdin },
			stdout: { value: stdout },
			stderr: { value: stderr },
		})
		const processRunner: ProcessRunner = {
			spawn: () => {
				stdout.end('partial output\n')
				stderr.end('command diagnostics\n')
				setTimeout(() => child.emit('close', 17, 'SIGTERM'), 0)
				return child
			},
			execFile: async (): Promise<ExecFileResult> => {
				throw new Error('Unexpected execFile call')
			},
		}
		const executor = new ShellExecutor(defaultConfig, {
			fs: testPlatform.fs,
			process: processRunner,
		})

		const result = await executor.execute(
			{ command: 'rejects-stdin', stdin: 'undelivered input' },
			createTestEnvironment(),
		)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toContain('stdin rejected')
		expect(result.error.details).toEqual(expect.objectContaining({
			stdout: 'partial output',
			stderr: 'command diagnostics',
			exitCode: 17,
			signal: 'SIGTERM',
			timedOut: false,
			durationMs: expect.any(Number),
		}))
	})

	it('waits for close after a process error and keeps timeout termination active', async () => {
		const killSignals: NodeJS.Signals[] = []
		const child = new ChildProcess()
		Object.defineProperties(child, {
			pid: { value: 424_246 },
			stdin: { value: null },
			stdout: { value: null },
			stderr: { value: null },
			kill: {
				value: (signal: NodeJS.Signals) => {
					killSignals.push(signal)
					return true
				},
			},
		})
		const processRunner: ProcessRunner = {
			spawn: () => child,
			execFile: async (): Promise<ExecFileResult> => {
				throw new Error('Unexpected execFile call')
			},
		}
		const executor = new ShellExecutor({ ...defaultConfig, timeout: 10 }, {
			fs: testPlatform.fs,
			process: processRunner,
		})
		let completed = false
		const resultPromise = executor.execute({ command: 'runtime-error' }, createTestEnvironment())
		resultPromise.then(() => {
			completed = true
		})

		child.emit('error', new Error('runtime process error'))
		await Bun.sleep(30)
		expect(completed).toBe(false)
		expect(killSignals).toEqual(['SIGTERM'])

		child.emit('close', null, 'SIGTERM')
		const result = await resultPromise
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toContain('runtime process error')
	})

	it('fails when a child closes before stdin settles', async () => {
		let finishWrite: (() => void) | undefined
		const stdin = new Writable({
			write(_chunk, _encoding, callback) {
				finishWrite = callback
			},
		})
		const child = new ChildProcess()
		Object.defineProperties(child, {
			pid: { value: 424_247 },
			stdin: { value: stdin },
			stdout: { value: null },
			stderr: { value: null },
		})
		const processRunner: ProcessRunner = {
			spawn: () => child,
			execFile: async (): Promise<ExecFileResult> => {
				throw new Error('Unexpected execFile call')
			},
		}
		const executor = new ShellExecutor(defaultConfig, {
			fs: testPlatform.fs,
			process: processRunner,
		})
		const resultPromise = executor.execute(
			{ command: 'closes-early', stdin: 'pending input' },
			createTestEnvironment(),
		)

		child.emit('close', 0, null)
		const result = await resultPromise
		finishWrite?.()
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toContain('closed before accepting all stdin input')
	})

	it('fails when requested stdin is unavailable', async () => {
		const child = new ChildProcess()
		Object.defineProperties(child, {
			pid: { value: 424_248 },
			stdin: { value: null },
			stdout: { value: null },
			stderr: { value: null },
		})
		const processRunner: ProcessRunner = {
			spawn: () => {
				setTimeout(() => child.emit('close', 0, null), 0)
				return child
			},
			execFile: async (): Promise<ExecFileResult> => {
				throw new Error('Unexpected execFile call')
			},
		}
		const executor = new ShellExecutor(defaultConfig, {
			fs: testPlatform.fs,
			process: processRunner,
		})

		const result = await executor.execute(
			{ command: 'missing-stdin', stdin: 'input' },
			createTestEnvironment(),
		)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toContain('stdin is unavailable')
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
