import { describe, expect, it } from 'bun:test'
import { ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { SessionEnvironment } from '~/core/sessions/session-environment.js'
import type { ExecFileResult, ProcessRunner, SpawnOptions } from '~/platform/process.js'
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
		await Bun.sleep(0)

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
		await Bun.sleep(0)

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

// ============================================================================
// Sandbox containment and resource limits
// ============================================================================

interface SpawnCall {
	command: string
	args: string[]
	options?: SpawnOptions
}

function createCapturingRunner(bwrapAvailable = true): { runner: ProcessRunner; calls: SpawnCall[] } {
	const calls: SpawnCall[] = []
	const runner: ProcessRunner = {
		spawn: (command, args, options) => {
			calls.push({ command, args, options })
			const child = new ChildProcess()
			Object.defineProperties(child, {
				pid: { value: 424_250 + calls.length },
				stdin: { value: null },
				stdout: { value: null },
				stderr: { value: null },
			})
			setTimeout(() => child.emit('close', 0, null), 0)
			return child
		},
		execFile: async (file): Promise<ExecFileResult> => {
			if (file === 'bwrap' && bwrapAvailable) return { stdout: 'bubblewrap 0.8.0', stderr: '' }
			throw new Error(`spawn ${file} ENOENT`)
		},
	}
	return { runner, calls }
}

const sandboxedConfig: ShellConfig = {
	cwd: process.cwd(),
	timeout: 5000,
	sandboxed: true,
	sandbox: { enabled: true },
}

const createSandboxedEnvironment = (): SessionEnvironment => ({
	sessionDir: process.cwd(),
	sandboxed: true,
})

describe('sandbox cwd containment', () => {
	it('rejects a working directory outside the virtual roots', async () => {
		const { runner, calls } = createCapturingRunner()
		const executor = new ShellExecutor(sandboxedConfig, { fs: testPlatform.fs, process: runner })

		const result = await executor.execute({ command: 'pwd', cwd: '/etc' }, createSandboxedEnvironment())

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toContain('/home/user/session/')
		expect(calls).toEqual([])
	})

	it('rejects a working directory that traverses out of the session root', async () => {
		const { runner, calls } = createCapturingRunner()
		const executor = new ShellExecutor(sandboxedConfig, { fs: testPlatform.fs, process: runner })

		const result = await executor.execute(
			{ command: 'pwd', cwd: '/home/user/session/../../../etc' },
			createSandboxedEnvironment(),
		)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toContain('outside allowed directories')
		expect(calls).toEqual([])
	})

	it('rejects a workspace working directory when the session has no workspace', async () => {
		const { runner } = createCapturingRunner()
		const executor = new ShellExecutor(sandboxedConfig, { fs: testPlatform.fs, process: runner })

		const result = await executor.execute(
			{ command: 'pwd', cwd: '/home/user/workspace/app' },
			createSandboxedEnvironment(),
		)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toContain('No workspace directory')
	})

	it('passes a contained working directory to --chdir', async () => {
		const { runner, calls } = createCapturingRunner()
		const executor = new ShellExecutor(sandboxedConfig, { fs: testPlatform.fs, process: runner })

		const result = await executor.execute(
			{ command: 'pwd', cwd: '/home/user/session/packages/./sdk' },
			createSandboxedEnvironment(),
		)

		expect(result.ok).toBe(true)
		expect(calls[0].command).toBe('bwrap')
		const chdirIdx = calls[0].args.indexOf('--chdir')
		expect(calls[0].args[chdirIdx + 1]).toBe('/home/user/session/packages/sdk')
	})
})

describe('resource limits', () => {
	it('caps memory, file size, cpu time and processes inside the sandbox', async () => {
		const { runner, calls } = createCapturingRunner()
		const executor = new ShellExecutor(sandboxedConfig, { fs: testPlatform.fs, process: runner })

		await executor.execute({ command: 'echo hi' }, createSandboxedEnvironment())

		const command = calls[0].args[calls[0].args.length - 1]
		expect(command).toContain('ulimit -v 524288')
		expect(command).toContain('ulimit -f 204800')
		expect(command).toContain('ulimit -t 5')
		expect(command).toContain('ulimit -u 64')
		expect(command).toContain('echo hi')
	})

	it('fails the command when a limit cannot be applied', async () => {
		const { runner, calls } = createCapturingRunner()
		const executor = new ShellExecutor(sandboxedConfig, { fs: testPlatform.fs, process: runner })

		await executor.execute({ command: 'echo hi' }, createSandboxedEnvironment())

		const command = calls[0].args[calls[0].args.length - 1]
		expect(command).not.toContain('ulimit -v 524288 2>/dev/null')
		expect(command).toContain('exit 126')
	})

	it('applies limits on the direct spawn path, without the host-wide process cap', async () => {
		const { runner, calls } = createCapturingRunner()
		const executor = new ShellExecutor(defaultConfig, { fs: testPlatform.fs, process: runner })

		await executor.execute({ command: 'echo hi' }, createTestEnvironment())

		const command = calls[0].args[1]
		expect(command).toContain('ulimit -v 524288')
		expect(command).toContain('ulimit -f 204800')
		expect(command).toContain('exit 126')
		expect(command).not.toContain('ulimit -u')
	})

	it('honours configured limits and lets a session opt out', async () => {
		const { runner, calls } = createCapturingRunner()
		const configured = new ShellExecutor(
			{ ...defaultConfig, resourceLimits: { virtualMemoryKb: 1024, fileSizeKb: 2048 } },
			{ fs: testPlatform.fs, process: runner },
		)
		await configured.execute({ command: 'echo hi' }, createTestEnvironment())
		expect(calls[0].args[1]).toContain('ulimit -v 1024')
		expect(calls[0].args[1]).toContain('ulimit -f 2048')

		const disabled = new ShellExecutor(
			{ ...defaultConfig, resourceLimits: { enabled: false } },
			{ fs: testPlatform.fs, process: runner },
		)
		await disabled.execute({ command: 'echo hi' }, createTestEnvironment())
		expect(calls[1].args[1]).toBe('echo hi')
	})

	it('enforces the file size limit on a real command', async () => {
		const target = join(tmpdir(), `roj-shell-limit-${process.pid}.bin`)
		const executor = new ShellExecutor(
			{ ...defaultConfig, resourceLimits: { fileSizeKb: 1 } },
			testExecutorDeps,
		)

		const result = await executor.execute(
			{ command: `head -c 200000 /dev/zero > ${target}` },
			createTestEnvironment(),
		)
		await rm(target, { force: true })

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.value.exitCode).not.toBe(0)
	})
})

describe('sandbox availability', () => {
	it('refuses to run when the sandbox is requested but unavailable', async () => {
		const { runner, calls } = createCapturingRunner(false)
		const executor = new ShellExecutor(sandboxedConfig, { fs: testPlatform.fs, process: runner })

		const result = await executor.execute({ command: 'echo hi' }, createSandboxedEnvironment())

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toContain('requires a sandbox')
		expect(result.error.message).toContain('bwrap')
		expect(calls).toEqual([])
	})

	it('refuses to run when the sandbox is requested but disabled in config', async () => {
		const { runner, calls } = createCapturingRunner()
		const executor = new ShellExecutor(
			{ ...sandboxedConfig, sandbox: { enabled: false } },
			{ fs: testPlatform.fs, process: runner },
		)

		const result = await executor.execute({ command: 'echo hi' }, createSandboxedEnvironment())

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.message).toContain('allowUnconfined')
		expect(calls).toEqual([])
	})

	it('runs unconfined only when the session opts out explicitly', async () => {
		const { runner, calls } = createCapturingRunner(false)
		const executor = new ShellExecutor(
			{ ...sandboxedConfig, sandbox: { enabled: true, allowUnconfined: true } },
			{ fs: testPlatform.fs, process: runner },
		)

		const result = await executor.execute({ command: 'echo hi' }, createSandboxedEnvironment())

		expect(result.ok).toBe(true)
		expect(calls[0].command).not.toBe('bwrap')
	})

	it('probes the sandbox once per executor', async () => {
		let probes = 0
		const { runner } = createCapturingRunner()
		const countingRunner: ProcessRunner = {
			spawn: runner.spawn,
			execFile: (file, args, options) => {
				probes++
				return runner.execFile(file, args, options)
			},
		}
		const executor = new ShellExecutor(sandboxedConfig, { fs: testPlatform.fs, process: countingRunner })

		await executor.execute({ command: 'echo hi' }, createSandboxedEnvironment())
		await executor.execute({ command: 'echo hi' }, createSandboxedEnvironment())

		expect(probes).toBe(1)
	})
})
