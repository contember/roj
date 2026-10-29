import { afterEach, describe, expect, it } from 'bun:test'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sdkLink = join(import.meta.dir, '../src/sdk-link.ts')
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * A bundle outside any workspace and an entry that links the SDK and imports the bundle, as the
 * runtime's main does. Once the bundle loaded the SDK, the entry records in `loaded-in` whether it ran in
 * the relaunched process, then exits with 3, or waits when told to.
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
		await Bun.write(${JSON.stringify(join(dir, 'loaded-in'))}, process.env.ROJ_SANDBOX_RUNTIME_RELAUNCHED ? 'relaunched' : 'first')
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
function start(dir: string, entry: string, ...args: string[]) {
	return Bun.spawn([process.execPath, entry, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
}

async function run(dir: string, entry: string): Promise<{ exitCode: number; output: string }> {
	const proc = start(dir, entry)
	const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
	return { exitCode, output: stdout + stderr }
}

/** Where the bundle loaded, and whether the SDK link exists. */
async function state(dir: string): Promise<{ loadedIn: string; linked: boolean }> {
	const loadedIn = await readFile(join(dir, 'loaded-in'), 'utf8').catch(() => 'nowhere')
	const linked = await lstat(join(dir, 'node_modules', '@roj-ai')).then(stat => stat.isSymbolicLink(), () => false)
	return { loadedIn, linked }
}

describe('linkSdkOrRelaunch', () => {
	it('lets an external-SDK bundle import the SDK on the first start', async () => {
		const { dir, entry } = await createBundleDir()
		const { exitCode, output } = await run(dir, entry)

		expect({ exitCode, output }).toMatchObject({ exitCode: 3 })
		expect(await state(dir)).toEqual({ loadedIn: 'relaunched', linked: true })
	})

	it('loads the bundle in the same process once the link exists', async () => {
		const { dir, entry } = await createBundleDir()
		await run(dir, entry)
		await rm(join(dir, 'loaded-in'))
		const { exitCode, output } = await run(dir, entry)

		expect({ exitCode, output }).toMatchObject({ exitCode: 3 })
		expect(await state(dir)).toEqual({ loadedIn: 'first', linked: true })
	})

	it('passes a termination signal to the relaunched process', async () => {
		const { dir, entry } = await createBundleDir()
		const proc = start(dir, entry, 'wait')
		const reader = proc.stdout.getReader()
		let stdout = ''
		while (!stdout.includes('ready')) {
			const { value, done } = await reader.read()
			if (done) throw new Error(`exited before ready: ${stdout}${await new Response(proc.stderr).text()}`)
			stdout += new TextDecoder().decode(value)
		}
		proc.kill('SIGTERM')

		expect(await proc.exited).toBe(143)
	})
})
