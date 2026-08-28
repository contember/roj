import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ShellGrant, ShellRunResult } from '../platform/index.js'
import { createBunShellRunner } from './shell.js'

const SESSION = '/home/user/session'

function sandboxUsable(): boolean {
	try {
		return Bun.spawnSync(['bwrap', '--dev-bind', '/', '/', '--unshare-all', 'true']).success
	} catch {
		return false
	}
}

/** The compiler is the workload that matters: it holds a large JS heap, unlike the native bundler. */
function findCompiler(): string | undefined {
	let dir = import.meta.dir
	while (true) {
		const candidate = join(dir, 'node_modules/typescript/lib/tsc.js')
		if (existsSync(candidate)) return candidate
		const parent = dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}

/** Soft limit as `/proc/self/limits` reports it, in the units of that file. */
function softLimit(output: string, name: string): string | undefined {
	const line = output.split('\n').find((row) => row.startsWith(name))
	return line?.slice(name.length).trim().split(/\s+/)[0]
}

const usable = sandboxUsable()
/** CI sets this so a host without a working sandbox fails these tests instead of skipping them. */
const required = process.env.ROJ_REQUIRE_SANDBOX === '1'
const runIt = it.skipIf(!usable && !required)

async function confinedRun(
	sessionDir: string,
	command: string,
	extraGrants: ShellGrant[] = [],
	timeoutMs = 120_000,
): Promise<ShellRunResult> {
	const toolchainDir = dirname(process.execPath)
	const grants: ShellGrant[] = [
		{ path: SESSION, source: sessionDir, mode: 'rw' },
		{ path: toolchainDir, mode: 'ro' },
		...extraGrants,
	]
	return createBunShellRunner().run({
		command,
		cwd: SESSION,
		grants,
		env: { HOME: SESSION, PATH: `${toolchainDir}:/usr/local/bin:/usr/bin:/bin` },
		timeoutMs,
	})
}

describe('the limits a confined command actually runs under', () => {
	runIt('reports them on the command itself, not on a subshell', async () => {
		expect(usable).toBe(true)
		const sessionDir = await mkdtemp(join(tmpdir(), 'roj-limits-'))

		const result = await confinedRun(sessionDir, 'cat /proc/self/limits')
		await rm(sessionDir, { recursive: true, force: true })

		expect(result.exitCode).toBe(0)

		// 200 MB, or twice that on a shell whose `ulimit -f` counts 1024-byte blocks.
		const fileSize = softLimit(result.stdout, 'Max file size')
		expect(fileSize).not.toBe('unlimited')
		expect(Number(fileSize)).toBeGreaterThanOrEqual(209_715_200)

		expect(softLimit(result.stdout, 'Max processes')).toBe('64')

		// The runner bounds wall time itself; RLIMIT_CPU would kill a parallel build early.
		expect(softLimit(result.stdout, 'Max cpu time')).toBe('unlimited')
		// RLIMIT_AS tracks mapped address space, which a build reserves far beyond what it uses.
		expect(softLimit(result.stdout, 'Max address space')).toBe('unlimited')
	}, 60_000)

	/** Eight workers burning >3s of wall time spend >24 CPU-seconds — far more than this 10s timeout. */
	runIt('runs a parallel burst that a timeout-derived CPU cap would have killed', async () => {
		expect(usable).toBe(true)
		const sessionDir = await mkdtemp(join(tmpdir(), 'roj-limits-cpu-'))
		const started = Date.now()

		const result = await confinedRun(
			sessionDir,
			'for i in 1 2 3 4 5 6 7 8; do ( end=$(( $(date +%s) + 4 )); while [ $(date +%s) -lt $end ]; do :; done ) & done; wait',
			[],
			10_000,
		)
		const elapsed = Date.now() - started
		await rm(sessionDir, { recursive: true, force: true })

		expect(result).toMatchObject({ exitCode: 0, timedOut: false })
		expect(elapsed).toBeGreaterThanOrEqual(2500)
	}, 60_000)
})

describe('a confined toolchain run under the resource limits', () => {
	runIt('installs a dependency and compiles a package to completion', async () => {
		expect(usable).toBe(true)
		const compiler = findCompiler()
		expect(compiler).toBeDefined()
		if (!compiler) return

		const sessionDir = await mkdtemp(join(tmpdir(), 'roj-shell-limits-'))
		await mkdir(join(sessionDir, 'dep'))
		await writeFile(join(sessionDir, 'dep/package.json'), '{"name":"dep","version":"1.0.0","main":"index.js"}\n')
		await writeFile(join(sessionDir, 'dep/index.js'), 'module.exports = 42\n')
		await writeFile(
			join(sessionDir, 'package.json'),
			'{"name":"smoke","version":"1.0.0","dependencies":{"dep":"file:./dep"}}\n',
		)
		await writeFile(join(sessionDir, 'index.ts'), 'export const answer: number = 42\n')

		const compilerDir = dirname(dirname(compiler))
		const grant: ShellGrant[] = [{ path: compilerDir, mode: 'ro' }]

		const install = await confinedRun(sessionDir, 'bun install', grant)
		const installed = await confinedRun(sessionDir, 'test -f node_modules/dep/index.js', grant)
		const compile = await confinedRun(
			sessionDir,
			`bun ${compiler} index.ts --outDir build --skipLibCheck --lib es2022`,
			grant,
		)
		await rm(sessionDir, { recursive: true, force: true })

		expect(install).toMatchObject({ exitCode: 0, timedOut: false })
		expect(install.stdout).toContain('1 package installed')
		expect(installed.exitCode).toBe(0)
		expect(compile).toMatchObject({ exitCode: 0, timedOut: false, stderr: '' })
	}, 180_000)
})
