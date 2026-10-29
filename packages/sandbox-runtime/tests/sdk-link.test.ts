import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sdkLink = join(import.meta.dir, '../src/sdk-link.ts')
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * A bundle outside any workspace and an entry that links the SDK and imports the bundle, as the
 * runtime's main does. The entry exits with 3 once the bundle loaded the SDK, or waits when told to.
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

function count(text: string, needle: string): number {
	return text.split(needle).length - 1
}

describe('linkSdkOrRelaunch', () => {
	it('lets an external-SDK bundle import the SDK on the first start', async () => {
		const { dir, entry } = await createBundleDir()
		const { exitCode, output } = await run(dir, entry)

		expect({ exitCode, output }).toMatchObject({ exitCode: 3 })
		expect(count(output, '[sandbox-runtime] linked')).toBe(1)
		expect(count(output, '[sandbox-runtime] restarting')).toBe(1)
	})

	it('loads the bundle in the same process once the link exists', async () => {
		const { dir, entry } = await createBundleDir()
		await run(dir, entry)
		const { exitCode, output } = await run(dir, entry)

		expect({ exitCode, output }).toMatchObject({ exitCode: 3 })
		expect(output).not.toContain('[sandbox-runtime] linked')
		expect(output).not.toContain('[sandbox-runtime] restarting')
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
