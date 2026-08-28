import { describe, expect, it } from 'bun:test'
import { ModelId, type Preset } from '@roj-ai/sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import {
	isLoopbackHost,
	resolveStandaloneHost,
	startStandaloneServer,
	type StartStandaloneOptions,
	warnIfStandaloneExposed,
} from '../src/server.js'

const DownloadUrlRpcSchema = z.object({
	ok: z.literal(true),
	value: z.object({ url: z.string(), expiresAt: z.string() }),
})

describe('standalone network boundary', () => {
	it('defaults to loopback and gives explicit config precedence over HOST', () => {
		expect(resolveStandaloneHost(undefined, undefined)).toBe('127.0.0.1')
		expect(resolveStandaloneHost(undefined, '192.0.2.10')).toBe('192.0.2.10')
		expect(resolveStandaloneHost('localhost', '192.0.2.10')).toBe('localhost')
	})

	it('recognizes IPv4, IPv6, and mapped loopback hosts', () => {
		expect(isLoopbackHost('localhost')).toBe(true)
		expect(isLoopbackHost('127.3.2.1')).toBe(true)
		expect(isLoopbackHost('[::1]')).toBe(true)
		expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true)
		expect(isLoopbackHost('0.0.0.0')).toBe(false)
		expect(isLoopbackHost('192.0.2.10')).toBe(false)
	})

	it('warns clearly when an explicit host exposes the unauthenticated server', () => {
		const warnings: Array<{ message: string; context?: Record<string, unknown> }> = []
		const logger = {
			warn(message: string, context?: Record<string, unknown>) {
				warnings.push({ message, context })
			},
		}

		warnIfStandaloneExposed('127.0.0.1', logger)
		warnIfStandaloneExposed('0.0.0.0', logger)

		expect(warnings).toEqual([{
			message: 'Standalone server is listening on a non-loopback host without authentication',
			context: {
				host: '0.0.0.0',
				action: 'Bind to 127.0.0.1 unless network access is intentional and protected externally',
			},
		}])
	})

	it('uses the OS-assigned port in generated public URLs', async () => {
		const dataPath = await mkdtemp(join(tmpdir(), 'roj-standalone-port-'))
		let handle: Awaited<ReturnType<typeof startStandaloneServer>> | undefined
		try {
			handle = await startStandaloneServer({
				presets: [{
					id: 'edit',
					name: 'Edit',
					orchestrator: {
						system: 'Test orchestrator',
						model: ModelId('mock'),
						tools: [],
						agents: [],
					},
					agents: [],
				}],
				config: {
					port: 0,
					host: '127.0.0.1',
					dataPath,
					persistence: 'memory',
					logLevel: 'error',
					logFormat: 'console',
					llmMock: () => ({
						content: 'unused',
						toolCalls: [],
						finishReason: 'stop',
						metrics: {
							promptTokens: 0,
							completionTokens: 0,
							totalTokens: 0,
							latencyMs: 0,
							model: 'mock',
						},
					}),
				},
			})

			const response = await fetch(`http://127.0.0.1:${handle.port}/api/v1/rpc`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					method: 'sessionFiles.createDownloadUrl',
					input: {
						instanceId: handle.instance.id,
						sessionId: 'session-1',
						scope: 'workspace',
						path: 'artifact.zip',
					},
				}),
			})
			const result = DownloadUrlRpcSchema.parse(await response.json())
			const downloadUrl = new URL(result.value.url)

			expect(handle.port).toBeGreaterThan(0)
			expect(downloadUrl.hostname).toBe('127.0.0.1')
			expect(downloadUrl.port).toBe(String(handle.port))
		} finally {
			await handle?.shutdown()
			await rm(dataPath, { recursive: true, force: true })
		}
	}, 15_000)
})

// =========================================================================
// Sandbox settings reaching a running host
// =========================================================================

/** Minimal preset; `sandboxed` left absent unless a case declares it. */
function probePreset(sandboxed?: boolean): Preset {
	return {
		id: 'probe',
		name: 'Probe',
		sandboxed,
		orchestrator: { system: 'Test orchestrator', model: ModelId('mock'), tools: [], agents: [] },
		agents: [],
	}
}

/** Start a real host from the given config and report the posture its sessions get. */
async function sessionSandboxedUnder(options: Omit<StartStandaloneOptions, 'config'>): Promise<boolean> {
	const dataPath = await mkdtemp(join(tmpdir(), 'roj-standalone-sandbox-'))
	let handle: Awaited<ReturnType<typeof startStandaloneServer>> | undefined
	try {
		handle = await startStandaloneServer({
			...options,
			config: {
				port: 0,
				host: '127.0.0.1',
				dataPath,
				persistence: 'memory',
				logLevel: 'error',
				logFormat: 'console',
				llmMock: () => ({
					content: 'unused',
					toolCalls: [],
					finishReason: 'stop',
					metrics: { promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0, model: 'mock' },
				}),
			},
		})

		const created = await handle.sessionManager.createSession('probe')
		if (!created.ok) throw new Error(`createSession failed: ${JSON.stringify(created.error)}`)
		return created.value.environment.sandboxed
	} finally {
		await handle?.shutdown()
		await rm(dataPath, { recursive: true, force: true })
	}
}

describe('sandbox settings reach the session', () => {
	it('applies the top-level sandboxed flag to a preset that is silent', async () => {
		expect(await sessionSandboxedUnder({ presets: [probePreset()], sandboxed: true })).toBe(true)
	}, 15_000)

	it('leaves sessions unsandboxed when nothing declares it', async () => {
		expect(await sessionSandboxedUnder({ presets: [probePreset()] })).toBe(false)
	}, 15_000)

	it('lets a preset opt out of an enabled top-level flag', async () => {
		expect(await sessionSandboxedUnder({ presets: [probePreset(false)], sandboxed: true })).toBe(false)
	}, 15_000)

	it('lets a preset opt in when the top-level flag is off', async () => {
		expect(await sessionSandboxedUnder({ presets: [probePreset(true)], sandboxed: false })).toBe(true)
	}, 15_000)
})
