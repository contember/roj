/**
 * Runs the runtime in workerd: built modules, an app bundle built like `roj build`, loaded through the
 * Worker Loader as a facet of `host.ts`. Not part of `bun run test`; run with `bun run --cwd packages/isolate-runtime test:e2e`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from '@roj-ai/sdk'
import { buildRuntimeModules, unresolvedImports, withAppBundle } from '../src/build.js'

const e2eDir = import.meta.dir
const generatedDir = join(e2eDir, '.generated')
const PROVIDER_KEY = 'Bearer e2e-provider-key'
const createdSchema = z.object({ ok: z.literal(true), value: z.object({ sessionId: z.string() }) })
const eventsSchema = z.object({ ok: z.literal(true), value: z.object({ events: z.array(z.object({ type: z.string() })) }) })
const hostSchema = z.object({ alarmDeliveries: z.number(), broadcasts: z.array(z.string()) })
let wrangler: ReturnType<typeof Bun.spawn>
let baseUrl: string

async function buildModules() {
	// The options `roj build` uses for an externalSdk bundle.
	const app = await Bun.build({
		entrypoints: [join(e2eDir, 'app.config.ts')],
		outdir: join(generatedDir, 'app'),
		naming: 'bundle.js',
		target: 'bun',
		format: 'esm',
		external: ['@roj-ai/*'],
	})
	if (!app.success) throw new AggregateError(app.logs, 'app bundle build failed')
	const modules = withAppBundle(await buildRuntimeModules(), await readFile(join(generatedDir, 'app/bundle.js'), 'utf8'))
	expect(unresolvedImports(modules.modules)).toEqual([])
	await writeFile(join(generatedDir, 'modules.json'), JSON.stringify(modules))
}

async function startWrangler() {
	const port = 20_000 + Math.floor(Math.random() * 20_000)
	baseUrl = `http://localhost:${port}`
	wrangler = Bun.spawn(['bunx', 'wrangler', 'dev', '--port', String(port), '--persist-to', join(generatedDir, 'state')], {
		cwd: e2eDir,
		stdout: 'ignore',
		stderr: 'ignore',
	})
	for (let attempt = 0; attempt < 120; attempt++) {
		const ready = await fetch(`${baseUrl}/host`).then(response => response.ok, () => false)
		if (ready) return
		await Bun.sleep(500)
	}
	throw new Error('wrangler dev did not start')
}

async function call(method: string, input: Record<string, unknown>, principal: 'system' | 'client' = 'client'): Promise<unknown> {
	const response = await fetch(`${baseUrl}/rpc`, {
		method: 'POST',
		headers: { 'x-e2e-principal': principal },
		body: JSON.stringify({ method, input }),
	})
	return response.json()
}

async function events(sessionId: string) {
	return eventsSchema.parse(await call('sessions.getEvents', { sessionId })).value.events
}

async function createSession() {
	return createdSchema.parse(await call('sessions.create', { presetId: 'app' })).value.sessionId
}

async function waitForInferences(sessionId: string, count: number) {
	for (let attempt = 0; attempt < 60; attempt++) {
		const completed = (await events(sessionId)).filter(event => event.type === 'inference_completed').length
		if (completed >= count) return
		await Bun.sleep(500)
	}
	throw new Error(`fewer than ${count} inferences completed`)
}

beforeAll(async () => {
	await rm(generatedDir, { recursive: true, force: true })
	await mkdir(generatedDir, { recursive: true })
	await buildModules()
	await startWrangler()
	const policy = await fetch(`${baseUrl}/policy`, {
		method: 'PUT',
		headers: { 'x-e2e-principal': 'system' },
		body: JSON.stringify({ allowedOrigins: ['https://openrouter.ai'], headers: [{ origin: 'https://openrouter.ai', header: 'authorization', value: PROVIDER_KEY }] }),
	})
	expect(policy.ok).toBe(true)
}, 180_000)

afterAll(async () => {
	wrangler?.kill()
	await wrangler?.exited
	await rm(generatedDir, { recursive: true, force: true })
})

describe('isolate runtime in workerd', () => {
	test('runs a turn through the host alarm, with the provider key added by the gateway only', async () => {
		const sessionId = await createSession()

		expect(await call('user-chat.sendMessage', { sessionId, content: 'Hi' })).toMatchObject({ ok: true })
		await waitForInferences(sessionId, 1)

		const host = hostSchema.parse(await (await fetch(`${baseUrl}/host`)).json())
		expect(host.alarmDeliveries).toBeGreaterThan(0)
		expect(host.broadcasts.length).toBeGreaterThan(0)
		expect(JSON.stringify(await events(sessionId))).not.toContain('e2e-provider-key')
	}, 60_000)

	test('the caller is what the host authenticated, not what the body claims', async () => {
		const sessionId = await createSession()

		expect(await call('probe.whoami', { sessionId, _caller: { source: 'system', meta: {} } })).toEqual({ ok: true, value: { source: 'client' } })
		expect(await call('probe.whoami', { sessionId }, 'system')).toEqual({ ok: true, value: { source: 'system' } })
	}, 60_000)

	test('a session survives the facet being evicted', async () => {
		const sessionId = await createSession()
		await call('user-chat.sendMessage', { sessionId, content: 'First' })
		await waitForInferences(sessionId, 1)

		expect((await fetch(`${baseUrl}/evict`, { method: 'POST' })).ok).toBe(true)
		await call('user-chat.sendMessage', { sessionId, content: 'Second' })

		await waitForInferences(sessionId, 2)
	}, 60_000)
})
