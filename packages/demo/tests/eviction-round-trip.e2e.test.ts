/**
 * A client must not be able to tell that its session's runtime was evicted.
 *
 * The SDK suites cover eviction at the SessionManager level. This one drives the
 * same round trip the way a real client does — over the standalone-server REST
 * surface — so the projection a UI renders is what gets compared, not internal
 * state. It needs no API key and no snapshots: the LLM is stubbed by middleware,
 * which keeps it runnable in CI on every push.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRojClient } from '@roj-ai/client/platform'
import { createOrchestrator, createPreset, defineAgent, ModelId, ToolCallId } from '@roj-ai/sdk'
import { filesystemPlugin } from '@roj-ai/sdk/tools/filesystem'
import { waitForAllAgentsIdle } from '@roj-ai/sdk/testing'
import { startStandaloneServer, type StandaloneHandle } from '@roj-ai/standalone-server'

// Own data root, so the run touches neither the repo's ./data nor the snapshot
// e2e running beside it.
const DATA_DIR = '/tmp/roj-demo-eviction-e2e'
const IDLE_TIMEOUT_MS = 750

/**
 * No services and no shell: the round trip is what is under test, and an
 * auto-start `bunx serve` would drag a package download into CI.
 */
const evictionPreset = createPreset({
	id: 'eviction-probe',
	name: 'Eviction Probe',
	orchestrator: createOrchestrator({
		...defineAgent({
			name: 'probe',
			system: 'You are a test agent.',
			model: ModelId('anthropic/claude-haiku-4.5'),
			plugins: [filesystemPlugin.configureAgent({ directoryListing: { maxDepth: 1 } })],
			tools: [],
			agents: [],
		}),
		agents: [],
	}),
})

const metrics = { promptTokens: 10, completionTokens: 5, totalTokens: 15, latencyMs: 1, model: 'stub' }

describe('runtime eviction round trip', () => {
	let handle: StandaloneHandle
	let client: ReturnType<typeof createRojClient>
	let llmCalls = 0
	/** Set once the session exists — writes need the absolute path the real prompt would carry. */
	let workspaceDir = ''

	const rpc = async (method: string, input: unknown): Promise<unknown> => {
		const response = await fetch(`http://127.0.0.1:${handle.port}/api/v1/instances/${handle.instance.id}/rpc`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ method, input }),
		})
		expect(response.status).toBe(200)
		const body = (await response.json()) as { ok: boolean; value?: unknown; error?: { message: string } }
		if (!body.ok) throw new Error(`${method} failed: ${body.error?.message}`)
		return body.value
	}

	beforeAll(async () => {
		rmSync(DATA_DIR, { recursive: true, force: true })
		mkdirSync(DATA_DIR, { recursive: true })

		handle = await startStandaloneServer({
			presets: [evictionPreset],
			config: {
				port: 0,
				host: '127.0.0.1',
				persistence: 'memory',
				dataPath: DATA_DIR,
				sessionIdleTimeoutMs: IDLE_TIMEOUT_MS,
				openRouterApiKey: 'stub-only',
				llmLoggingEnabled: false,
				logLevel: 'error',
			},
			// Deterministic stand-in for the provider: write a file, say so, stop.
			llmMiddleware: [
				async () => {
					llmCalls++
					if (llmCalls === 1) {
						return {
							ok: true as const,
							value: {
								content: null,
								toolCalls: [
									{
										id: ToolCallId('call-write'),
										name: 'write_file',
										input: { path: join(workspaceDir, 'index.html'), content: '<h1>Hello from roj</h1>' },
									},
									{ id: ToolCallId('call-tell'), name: 'tell_user', input: { message: 'Built the page.' } },
								],
								finishReason: 'tool_calls' as const,
								metrics,
							},
						}
					}
					return {
						ok: true as const,
						value: { content: 'Written.', toolCalls: [], finishReason: 'stop' as const, metrics },
					}
				},
			],
		})

		client = createRojClient({ url: `http://127.0.0.1:${handle.port}`, apiKey: '' })
	})

	afterAll(async () => {
		await handle?.shutdown()
		rmSync(DATA_DIR, { recursive: true, force: true })
	})

	test('a client reads the same session after its runtime was evicted', async () => {
		const { sessionId } = await client.sessions.create({
			instanceId: handle.instance.id,
			presetId: 'eviction-probe',
		})
		expect(sessionId).toBeTruthy()

		const loaded = await handle.sessionManager.getSession(sessionId as never)
		if (!loaded.ok) throw new Error(`getSession failed: ${loaded.error.message}`)
		workspaceDir = loaded.value.state.workspaceDir ?? ''
		expect(workspaceDir).not.toBe('')

		await rpc('user-chat.sendMessage', { sessionId, content: 'Build the page.' })
		await waitForAllAgentsIdle(loaded.value, { timeoutMs: 30_000 })

		const indexPath = join(workspaceDir, 'index.html')
		expect(existsSync(indexPath)).toBe(true)

		const before = (await rpc('user-chat.getMessages', { sessionId })) as { messages: unknown[] }
		// A user message and the agent's reply — enough that a lost projection shows up.
		expect(before.messages.length).toBe(2)
		const callsBeforeEviction = llmCalls

		// Nothing holds a lease once the turn is done, so the sweep must reclaim it.
		const deadline = Date.now() + 15_000
		while (Date.now() < deadline && handle.sessionManager.getRuntimeCacheStats().loadedSessionCount > 0) {
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		expect(handle.sessionManager.getRuntimeCacheStats().loadedSessionCount).toBe(0)

		// An evicted runtime is not a closed session — the REST listing still has it.
		const listed = await client.sessions.list(handle.instance.id)
		expect(listed.sessions.map((entry) => entry.id)).toContain(sessionId)
		expect(listed.sessions.find((entry) => entry.id === sessionId)?.status).toBe('active')

		// The read itself rebuilds the runtime; the client sees no difference.
		expect(await rpc('user-chat.getMessages', { sessionId })).toEqual(before)
		expect(existsSync(indexPath)).toBe(true)
		// A rebuild that re-ran the agent would have burned another LLM call.
		expect(llmCalls).toBe(callsBeforeEviction)
	}, 60_000)
})
