import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod/v4'

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts')

const PRESET = `{ id: 'probe', name: 'Probe', orchestrator: { system: 's', model: 'mock', tools: [], agents: [] }, agents: [] }`

const LoadedPresetsSchema = z.object({ message: z.literal('Loaded presets'), sandbox: z.string() })

const dirs: string[] = []

afterAll(async () => {
	await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

/** Boot the CLI against a config file and report the posture it logs. */
async function loggedSandboxPosture(configBody: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'roj-standalone-main-'))
	dirs.push(dir)
	const configPath = join(dir, 'roj.config.ts')
	await writeFile(configPath, `export default { presets: [${PRESET}], ${configBody} }\n`)

	const proc = Bun.spawn(['bun', MAIN, configPath], {
		env: {
			...process.env,
			PORT: '0',
			HOST: '127.0.0.1',
			PERSISTENCE: 'memory',
			DATA_PATH: join(dir, 'data'),
			ANTHROPIC_API_KEY: 'test-key-not-used',
			LOG_FORMAT: 'json',
			LOG_LEVEL: 'info',
		},
		stdout: 'pipe',
		stderr: 'pipe',
	})

	try {
		const line = await readLine(proc.stdout, /"message":"Loaded presets"/, 20_000)
		return LoadedPresetsSchema.parse(JSON.parse(line)).sandbox
	} finally {
		proc.kill()
		await proc.exited
	}
}

async function readLine(stream: ReadableStream<Uint8Array>, match: RegExp, timeoutMs: number): Promise<string> {
	const decoder = new TextDecoder()
	const reader = stream.getReader()
	let buffer = ''
	const deadline = Date.now() + timeoutMs

	try {
		while (Date.now() < deadline) {
			const next = await Promise.race([
				reader.read(),
				Bun.sleep(deadline - Date.now()).then(() => 'timeout' as const),
			])
			if (next === 'timeout') break
			if (next.done) break
			buffer += decoder.decode(next.value, { stream: true })
			const line = buffer.split('\n').find(l => match.test(l))
			if (line) return line
		}
	} finally {
		reader.cancel().catch(() => {})
	}
	throw new Error(`No line matching ${match} within ${timeoutMs}ms. Output:\n${buffer}`)
}

describe('standalone CLI', () => {
	it('boots with the sandbox the config declares', async () => {
		expect(await loggedSandboxPosture(`sandboxed: true`)).toBe('on')
	}, 30_000)

	it('boots unsandboxed when the config declares nothing', async () => {
		expect(await loggedSandboxPosture(`sandboxed: undefined`)).toBe('off')
	}, 30_000)
})
