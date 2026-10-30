import { afterEach, describe, expect, it } from 'bun:test'
import { createRequire } from 'node:module'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sdkLink = join(import.meta.dir, '../src/sdk-link.ts')
const runtimeRojDir = resolve(createRequire(sdkLink).resolve('@roj-ai/sdk/package.json'), '..', '..')
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * A bundle outside any workspace and an entry that links the SDK and imports the bundle, as the
 * runtime's main does. Once the bundle loaded the SDK, the entry records its parent's pid in `loaded-in`,
 * then exits with 3, or waits when told to.
 */
async function createBundleDir(): Promise<{ dir: string; entry: string }> {
	const dir = await mkdtemp(join(tmpdir(), 'roj-sdk-link-'))
	dirs.push(dir)
	await writeFile(join(dir, 'agent-bundle.js'), "export { defineConfig } from '@roj-ai/sdk/user-config'\n")
	const entry = join(dir, 'entry.ts')
	await writeFile(
		entry,
		`
		const { linkSdkOrRelaunch } = await import(${JSON.stringify(sdkLink)})
		const relaunchedExitCode = await linkSdkOrRelaunch(${JSON.stringify(dir)})
		if (relaunchedExitCode !== null) process.exit(relaunchedExitCode)
		const mod = await import(${JSON.stringify(join(dir, 'agent-bundle.js'))})
		if (typeof mod.defineConfig !== 'function') throw new Error('bundle did not load the SDK')
		await Bun.write(${JSON.stringify(join(dir, 'loaded-in'))}, String(process.ppid))
		if (process.argv[2] === 'wait') {
			console.log('ready')
			setInterval(() => {}, 1000)
		} else {
			process.exit(3)
		}
		`,
	)
	return { dir, entry }
}

/** Starts the entry in the bundle's directory, as a sandbox host does. */
function start(dir: string, entry: string, args: string[] = [], env: Record<string, string> = {}) {
	return Bun.spawn([process.execPath, entry, ...args], { cwd: dir, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
}

async function run(dir: string, entry: string, env: Record<string, string> = {}): Promise<{ exitCode: number; output: string; pid: number }> {
	const proc = start(dir, entry, [], env)
	const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
	return { exitCode, output: stdout + stderr, pid: proc.pid }
}

/** Where the bundle loaded (the started process, or a process it relaunched), and whether the SDK link points at the runtime's own copy. */
async function state(dir: string, startedPid: number): Promise<{ loadedIn: string; linked: boolean }> {
	const parentPid = await readFile(join(dir, 'loaded-in'), 'utf8').catch(() => null)
	const loadedIn = parentPid === null ? 'nowhere' : parentPid === String(startedPid) ? 'relaunched' : 'first'
	const linkPath = join(dir, 'node_modules', '@roj-ai')
	const isLink = await lstat(linkPath).then(stat => stat.isSymbolicLink(), () => false)
	const linked = isLink && (await realpath(linkPath)) === (await realpath(runtimeRojDir))
	return { loadedIn, linked }
}

describe('linkSdkOrRelaunch', () => {
	it('lets an external-SDK bundle import the SDK on the first start', async () => {
		const { dir, entry } = await createBundleDir()
		const { exitCode, output, pid } = await run(dir, entry)

		expect({ exitCode, output }).toMatchObject({ exitCode: 3 })
		expect(await state(dir, pid)).toEqual({ loadedIn: 'relaunched', linked: true })
	})

	it('loads the bundle in the same process once the link exists', async () => {
		const { dir, entry } = await createBundleDir()
		await run(dir, entry)
		await rm(join(dir, 'loaded-in'))
		const { exitCode, output, pid } = await run(dir, entry)

		expect({ exitCode, output }).toMatchObject({ exitCode: 3 })
		expect(await state(dir, pid)).toEqual({ loadedIn: 'first', linked: true })
	})

	it('replaces a link to another SDK copy', async () => {
		const { dir, entry } = await createBundleDir()
		const otherRojDir = join(dir, 'other-runtime', '@roj-ai')
		await mkdir(join(otherRojDir, 'sdk'), { recursive: true })
		await writeFile(join(otherRojDir, 'sdk', 'package.json'), '{"name":"@roj-ai/sdk","version":"0.0.0"}')
		await mkdir(join(dir, 'node_modules'))
		await symlink(otherRojDir, join(dir, 'node_modules', '@roj-ai'), 'dir')
		const { exitCode, output, pid } = await run(dir, entry)

		expect({ exitCode, output }).toMatchObject({ exitCode: 3 })
		expect(await state(dir, pid)).toEqual({ loadedIn: 'relaunched', linked: true })
		expect(await Bun.file(join(otherRojDir, 'sdk', 'package.json')).exists()).toBe(true)
	})

	it('relaunches when it inherited the marker from a runtime that is not its parent', async () => {
		const { dir, entry } = await createBundleDir()
		// As set for an earlier runtime further up the process tree, whose pid is not this process's parent.
		const { exitCode, output, pid } = await run(dir, entry, { ROJ_SANDBOX_RUNTIME_RELAUNCHED: '1' })

		expect({ exitCode, output }).toMatchObject({ exitCode: 3 })
		expect(await state(dir, pid)).toEqual({ loadedIn: 'relaunched', linked: true })
	})

	it('passes a termination signal to the relaunched process', async () => {
		const { dir, entry } = await createBundleDir()
		const proc = start(dir, entry, ['wait'])
		const reader = proc.stdout.getReader()
		let stdout = ''
		while (!stdout.includes('ready')) {
			const { value, done } = await reader.read()
			if (done) throw new Error(`exited before ready: ${stdout}${await new Response(proc.stderr).text()}`)
			stdout += new TextDecoder().decode(value)
		}
		proc.kill('SIGTERM')

		expect(await proc.exited).toBe(143)
	}, 20_000)
})
