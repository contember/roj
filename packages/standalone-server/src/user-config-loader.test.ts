import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadUserConfig } from './user-config-loader.js'

const PRESET = `{ id: 'a', name: 'A', orchestrator: { system: 's', model: 'mock', tools: [], agents: [] }, agents: [] }`

const dirs: string[] = []

async function writeConfig(body: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'roj-config-'))
	dirs.push(dir)
	const path = join(dir, 'roj.config.ts')
	await writeFile(path, `export default { presets: [${PRESET}], ${body} }\n`)
	return path
}

afterAll(async () => {
	await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

describe('loadUserConfig', () => {
	it('returns the declared sandbox settings', async () => {
		const path = await writeConfig(`sandboxed: true, extraBinds: [{ path: '/opt/tools', mode: 'ro' }]`)
		const config = await loadUserConfig(path)
		expect(config.sandboxed).toBe(true)
		expect(config.extraBinds).toEqual([{ path: '/opt/tools', mode: 'ro', destPath: undefined }])
	})

	it('keeps an explicit destPath', async () => {
		const path = await writeConfig(`extraBinds: [{ path: '/opt/tools', mode: 'rw', destPath: '/tools' }]`)
		const config = await loadUserConfig(path)
		expect(config.extraBinds).toEqual([{ path: '/opt/tools', mode: 'rw', destPath: '/tools' }])
	})

	it('leaves extraBinds undefined when the config omits them', async () => {
		const config = await loadUserConfig(await writeConfig(`sandboxed: false`))
		expect(config.extraBinds).toBeUndefined()
	})

	it('rejects an unknown bind mode', async () => {
		const path = await writeConfig(`extraBinds: [{ path: '/opt/tools', mode: 'rx' }]`)
		await expect(loadUserConfig(path)).rejects.toThrow(/'mode' must be 'rw' or 'ro'/)
	})

	it('rejects a bind without a path', async () => {
		const path = await writeConfig(`extraBinds: [{ mode: 'ro' }]`)
		await expect(loadUserConfig(path)).rejects.toThrow(/missing required 'path'/)
	})

	it('rejects extraBinds that is not an array', async () => {
		const path = await writeConfig(`extraBinds: { path: '/opt/tools', mode: 'ro' }`)
		await expect(loadUserConfig(path)).rejects.toThrow(/'extraBinds' must be an array/)
	})
})
