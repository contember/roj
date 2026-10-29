import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sdkLink = join(import.meta.dir, '../src/sdk-link.ts')
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Links the SDK for a bundle outside any workspace and imports the bundle, in one fresh process like a sandbox start. */
async function startWithExternalSdkBundle(): Promise<{ exitCode: number; output: string }> {
	const dir = await mkdtemp(join(tmpdir(), 'roj-sdk-link-'))
	dirs.push(dir)
	const bundle = join(dir, 'agent-bundle.js')
	await writeFile(bundle, "export { defineConfig } from '@roj-ai/sdk/user-config'\n")
	const script = `
		const { ensureSdkResolvable } = await import(${JSON.stringify(sdkLink)})
		await ensureSdkResolvable(${JSON.stringify(dir)})
		const mod = await import(${JSON.stringify(bundle)})
		if (typeof mod.defineConfig !== 'function') throw new Error('bundle did not load the SDK')
	`
	const proc = Bun.spawn([process.execPath, '-e', script], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
	const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
	return { exitCode, output: stdout + stderr }
}

describe('ensureSdkResolvable', () => {
	it('lets an external-SDK bundle import the SDK on the first start', async () => {
		const { exitCode, output } = await startWithExternalSdkBundle()
		expect(output).toContain('[sandbox-runtime] linked')
		expect({ exitCode, output }).toMatchObject({ exitCode: 0 })
	})
})
