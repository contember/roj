import { describe, expect, it } from 'bun:test'
import { ChildProcess } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import type { ExecFileResult, ProcessRunner, ShellRunOptions } from '../platform/index.js'
import { buildBwrapArgs, createBunShellRunner } from './shell.js'

// ============================================================================
// Test Helpers
// ============================================================================

const stubProcessRunner = (spawn: ProcessRunner['spawn']): ProcessRunner => ({
	spawn,
	execFile: async (): Promise<ExecFileResult> => {
		throw new Error('Unexpected execFile call')
	},
})

const runOptions = (overrides: Partial<ShellRunOptions> & { command: string }): ShellRunOptions => ({
	cwd: '/tmp',
	timeoutMs: 5000,
	...overrides,
})

// ============================================================================
// buildBwrapArgs Tests
// ============================================================================

describe('buildBwrapArgs', () => {
	it('builds basic args with session dir mapping', () => {
		const args = buildBwrapArgs({
			command: 'echo hello',
			cwd: '/home/user/session',
			writablePaths: ['/home/user/session'],
			pathSources: { '/home/user/session': '/real/session/path' },
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
			writablePaths: ['/home/user/session'],
			pathSources: { '/home/user/session': '/tmp/session' },
			network: true,
		})

		expect(args).toContain('--share-net')
	})

	it('maps both session and workspace dirs', () => {
		const args = buildBwrapArgs({
			command: 'ls',
			cwd: '/home/user/session',
			writablePaths: ['/home/user/session', '/home/user/workspace'],
			pathSources: {
				'/home/user/session': '/real/session',
				'/home/user/workspace': '/real/workspace',
			},
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
			writablePaths: ['/home/user/session', '/home/user/project'],
			readablePaths: ['/opt/shared'],
			pathSources: { '/home/user/session': '/real/session' },
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
			writablePaths: ['/home/user/session', '/home/user/workspace'],
			pathSources: {
				'/home/user/session': '/real/session',
				'/home/user/workspace': '/real/workspace',
			},
		})

		const chdirIdx = args.indexOf('--chdir')
		expect(chdirIdx).toBeGreaterThan(0)
		expect(args[chdirIdx + 1]).toBe('/home/user/workspace')
	})

	it('binds an unmapped path where the host keeps it', () => {
		const args = buildBwrapArgs({
			command: 'ls',
			cwd: '/home/user',
			writablePaths: ['/home/user'],
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
// createBunShellRunner Tests
// ============================================================================

describe('createBunShellRunner', () => {
	it('reports paths confinement', () => {
		expect(createBunShellRunner().confinement).toBe('paths')
	})

	it('runs a command line through the shell', async () => {
		const result = await createBunShellRunner().run(runOptions({ command: "echo 'Hello, World!'" }))

		expect(result.stdout).toBe('Hello, World!')
		expect(result.stderr).toBe('')
		expect(result.exitCode).toBe(0)
		expect(result.timedOut).toBe(false)
	})

	it('confines through bwrap once a path is granted', async () => {
		let spawned: { command: string; args: string[] } | undefined
		const child = new ChildProcess()
		Object.defineProperties(child, {
			pid: { value: 424_249 },
			stdin: { value: null },
			stdout: { value: null },
			stderr: { value: null },
		})
		const runner = createBunShellRunner(stubProcessRunner((command, args) => {
			spawned = { command, args }
			setTimeout(() => child.emit('close', 0, null), 0)
			return child
		}))

		await runner.run(runOptions({
			command: 'ls',
			cwd: '/home/user/session',
			writablePaths: ['/home/user/session'],
			pathSources: { '/home/user/session': '/real/session' },
			timeoutMs: 4000,
		}))

		expect(spawned?.command).toBe('bwrap')
		expect(spawned?.args.slice(-3)).toEqual([
			'/bin/sh',
			'-c',
			'ulimit -v 524288 -f 204800 -u 64 -t 4 2>/dev/null; ls',
		])
	})

	it('rejects when stdin delivery fails before a zero exit', async () => {
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
		const runner = createBunShellRunner(stubProcessRunner(() => {
			setTimeout(() => child.emit('close', 0, null), 0)
			return child
		}))

		const failure = await runner
			.run(runOptions({ command: 'ignores-stdin', stdin: 'data after exit' }))
			.catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(Error)
		if (!(failure instanceof Error)) return
		expect(failure.message).toContain('Failed to deliver command stdin')
		expect(failure.message).toContain('broken pipe')
		expect('details' in failure ? failure.details : undefined).toEqual(
			expect.objectContaining({ exitCode: 0 }),
		)
	})

	it('resolves when stdin delivery finishes before a zero exit', async () => {
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
		const runner = createBunShellRunner(stubProcessRunner(() => {
			setTimeout(() => child.emit('close', 0, null), 0)
			return child
		}))

		const result = await runner.run(runOptions({ command: 'reads-stdin', stdin: 'delivered input' }))

		expect(result.exitCode).toBe(0)
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
		const runner = createBunShellRunner(stubProcessRunner(() => {
			stdout.end('partial output\n')
			stderr.end('command diagnostics\n')
			setTimeout(() => child.emit('close', 17, 'SIGTERM'), 0)
			return child
		}))

		const failure = await runner
			.run(runOptions({ command: 'rejects-stdin', stdin: 'undelivered input' }))
			.catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(Error)
		if (!(failure instanceof Error)) return
		expect(failure.message).toContain('stdin rejected')
		expect('details' in failure ? failure.details : undefined).toEqual({
			stdout: 'partial output',
			stderr: 'command diagnostics',
			exitCode: 17,
			signal: 'SIGTERM',
			timedOut: false,
			durationMs: expect.any(Number),
		})
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
		const runner = createBunShellRunner(stubProcessRunner(() => child))
		let completed = false
		const failurePromise = runner
			.run(runOptions({ command: 'runtime-error', timeoutMs: 10 }))
			.catch((error: unknown) => error)
		failurePromise.then(() => {
			completed = true
		})

		child.emit('error', new Error('runtime process error'))
		await Bun.sleep(30)
		expect(completed).toBe(false)
		expect(killSignals).toEqual(['SIGTERM'])

		child.emit('close', null, 'SIGTERM')
		const failure = await failurePromise
		expect(failure).toBeInstanceOf(Error)
		if (!(failure instanceof Error)) return
		expect(failure.message).toContain('runtime process error')
	})

	it('rejects when a child closes before stdin settles', async () => {
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
		const runner = createBunShellRunner(stubProcessRunner(() => child))
		const failurePromise = runner
			.run(runOptions({ command: 'closes-early', stdin: 'pending input' }))
			.catch((error: unknown) => error)

		child.emit('close', 0, null)
		const failure = await failurePromise
		finishWrite?.()
		expect(failure).toBeInstanceOf(Error)
		if (!(failure instanceof Error)) return
		expect(failure.message).toContain('closed before accepting all stdin input')
	})

	it('rejects when requested stdin is unavailable', async () => {
		const child = new ChildProcess()
		Object.defineProperties(child, {
			pid: { value: 424_248 },
			stdin: { value: null },
			stdout: { value: null },
			stderr: { value: null },
		})
		const runner = createBunShellRunner(stubProcessRunner(() => {
			setTimeout(() => child.emit('close', 0, null), 0)
			return child
		}))

		const failure = await runner
			.run(runOptions({ command: 'missing-stdin', stdin: 'input' }))
			.catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(Error)
		if (!(failure instanceof Error)) return
		expect(failure.message).toContain('stdin is unavailable')
	})

	it('caps each stream and says so', async () => {
		const result = await createBunShellRunner().run(runOptions({
			command: "yes 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' | head -c 2000000",
			timeoutMs: 20_000,
		}))

		expect(result.truncated).toBe(true)
		expect(result.stdout).toContain('[stdout truncated at 1 MB]')
	}, 30_000)

	it('terminates a command that outruns its timeout', async () => {
		const result = await createBunShellRunner().run(runOptions({ command: 'sleep 10', timeoutMs: 200 }))

		expect(result.timedOut).toBe(true)
		expect(result.signal).toBeDefined()
	}, 10_000)
})
