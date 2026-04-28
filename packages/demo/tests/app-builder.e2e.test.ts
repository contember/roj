/**
 * End-to-end test for the App Builder preset over the full @roj-ai/standalone-server
 * HTTP/WS surface.
 *
 * LLM calls are snapshotted with createSnapshotLLMMiddleware — the first run
 * with ANTHROPIC_API_KEY records; subsequent runs replay from disk without a
 * network call. Commit the generated __snapshots__/ directory.
 *
 * To (re-)record:
 *   ANTHROPIC_API_KEY=sk-... bun test packages/demo/tests/app-builder.e2e.test.ts
 *
 * To replay (CI, default):
 *   bun test packages/demo/tests/app-builder.e2e.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRojClient } from '@roj-ai/client/platform'
import { createSnapshotLLMMiddleware, normalizeStripRuntime } from '@roj-ai/sdk/llm/snapshot-middleware'
import { startStandaloneServer, type StandaloneHandle } from '@roj-ai/standalone-server'
import { waitForAllAgentsIdle } from '@roj-ai/sdk/testing'
import { appBuilderPreset } from '../agent/preset'

const SNAPSHOTS_DIR = join(import.meta.dir, '__snapshots__', 'app-builder')
// Stable workspace path (no {sessionId} template and no PID) — the cached
// LLM response embeds the exact path it saw at record time, so any per-run
// variation makes cached responses reference non-existent dirs. Shared across
// sessions within one test run; cleaned up in beforeAll + afterAll.
const WORKSPACE_DIR = '/tmp/roj-demo-e2e'

const hasApiKey = !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENROUTER_API_KEY
const hasSnapshots =
	existsSync(SNAPSHOTS_DIR) && readdirSync(SNAPSHOTS_DIR).some((f) => f.endsWith('.json'))
const canRunLiveTurn = hasApiKey || hasSnapshots

describe('App Builder e2e', () => {
	let handle: StandaloneHandle
	let client: ReturnType<typeof createRojClient>

	beforeAll(async () => {
		mkdirSync(SNAPSHOTS_DIR, { recursive: true })
		rmSync(WORKSPACE_DIR, { recursive: true, force: true })
		mkdirSync(WORKSPACE_DIR, { recursive: true })

		// Override workspaceDir so it is stable across runs (snapshots pin it).
		const testPreset = { ...appBuilderPreset, workspaceDir: WORKSPACE_DIR }

		handle = await startStandaloneServer({
			presets: [testPreset],
			config: {
				port: 0,
				host: '127.0.0.1',
				persistence: 'memory',
				// Register whichever provider we have a key for — middleware below
				// intercepts before any real call once a snapshot exists.
				anthropicApiKey: process.env.ANTHROPIC_API_KEY,
				openRouterApiKey: process.env.OPENROUTER_API_KEY ?? (process.env.ANTHROPIC_API_KEY ? undefined : 'snapshot-only'),
				llmLoggingEnabled: false,
				// 'error' silences the every-2s git-status warnings when the workspace
				// isn't a git repo. Raise to 'warn' while debugging.
				logLevel: 'error',
			},
			llmMiddleware: [
				createSnapshotLLMMiddleware({
					snapshotsDir: SNAPSHOTS_DIR,
					// Strip session UUIDs and randomly-assigned dev-service ports from
					// the request before hashing, so snapshots match across runs.
					normalize: normalizeStripRuntime,
					// Explicit ROJ_E2E_RECORD=1 to (re-)record; default is strict replay
					// in CI + auto in dev when snapshots are missing for a new branch.
					mode: process.env.ROJ_E2E_RECORD === '1' ? 'record' : hasSnapshots ? 'replay' : 'auto',
				}),
			],
		})

		client = createRojClient({ url: `http://127.0.0.1:${handle.port}`, apiKey: '' })
	})

	afterAll(async () => {
		await handle?.shutdown()
		rmSync(WORKSPACE_DIR, { recursive: true, force: true })
	})

	test('server exposes platform REST surface', async () => {
		const health = await fetch(`http://127.0.0.1:${handle.port}/health`)
		expect(health.status).toBe(200)

		const listed = await client.instances.list()
		expect(listed.instances.length).toBe(1)
		expect(listed.instances[0].instanceId).toBe(handle.instance.id)
	})

	test.skipIf(!canRunLiveTurn)('session completes a simple build turn', async () => {
		const session = await client.sessions.create({
			instanceId: handle.instance.id,
			presetId: 'app-builder',
		})
		expect(session.sessionId).toBeTruthy()

		// Send the initial prompt over the platform RPC surface (instance-scoped path).
		const sendResp = await fetch(
			`http://127.0.0.1:${handle.port}/api/v1/instances/${handle.instance.id}/rpc`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'user-chat.sendMessage',
					input: {
						sessionId: session.sessionId,
						content: 'Create an index.html file with the text "Hello from roj".',
					},
				}),
			},
		)
		expect(sendResp.status).toBe(200)
		const sendBody = (await sendResp.json()) as { ok: boolean; error?: { message: string } }
		if (!sendBody.ok) throw new Error(`sendMessage failed: ${sendBody.error?.message}`)

		// Grab the in-memory session from the manager and wait for agents to quiesce.
		// Exposed on StandaloneHandle specifically for test-facing introspection.
		const sessionObj = await handle.sessionManager.getSession(session.sessionId as any)
		if (!sessionObj.ok) throw new Error(`getSession failed: ${sessionObj.error.message}`)
		await waitForAllAgentsIdle(sessionObj.value, { timeoutMs: 120_000 })

		// At least one LLM call happened — snapshot files exist.
		const snapshots = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith('.json'))
		expect(snapshots.length).toBeGreaterThan(0)

		// Agent actually executed tool calls against the real filesystem —
		// index.html exists with the requested content. This catches cases where
		// snapshots replay but the replayed path refers to a non-existent dir.
		const indexPath = join(WORKSPACE_DIR, 'index.html')
		expect(existsSync(indexPath)).toBe(true)
		const contents = readFileSync(indexPath, 'utf-8')
		expect(contents.toLowerCase()).toContain('hello from roj')
	}, 150_000)
})
