/**
 * End-to-end test for the App Builder preset over the full @roj-ai/standalone-server
 * HTTP/WS surface.
 *
 * LLM calls are snapshotted with createSnapshotLLMMiddleware. Recording and
 * replay are explicit so stale snapshots never fall through to a live call.
 *
 * To (re-)record:
 *   ROJ_E2E_RECORD=1 ANTHROPIC_API_KEY=sk-... bun test packages/demo/tests/app-builder.e2e.test.ts
 *
 * To replay the build turn without network access:
 *   LIVE_TESTS=1 bun test packages/demo/tests/app-builder.e2e.test.ts
 *
 * The snapshot key covers the system prompt, so anything that changes it —
 * preset, model, tool set, workspace path — needs a re-record. CI replays the
 * build turn; `bun run test` alone runs only the REST-surface smoke test.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRojClient } from '@roj-ai/client/platform'
import {
	composeStrippers,
	createSnapshotLLMMiddleware,
	normalizeWith,
	stripEphemeralPorts,
	stripUuids,
} from '@roj-ai/sdk/llm/snapshot-middleware'
import { startStandaloneServer, type StandaloneHandle } from '@roj-ai/standalone-server'
import { waitForAllAgentsIdle } from '@roj-ai/sdk/testing'
import { appBuilderPreset } from '../agent/preset'

const SNAPSHOTS_DIR = join(import.meta.dir, '__snapshots__', 'app-builder')
// Own data root, so nothing lands in the repo's ./data.
const DATA_DIR = '/tmp/roj-demo-e2e-data'
// The recorded assistant turn contains a `write_file` call with the absolute
// workspace path it saw while recording, so that path has to be identical on
// every replay — a per-session directory makes every snapshot dead on arrival.
// The platform REST `sessions.create` mints its own UUID and puts the session in
// a git worktree, so the build turn creates its session through the manager with
// a fixed workspace instead; REST create is covered by the eviction e2e.
const WORKSPACE_DIR = '/tmp/roj-demo-e2e'

// The dev service runs with its cwd inside the session workspace, which sits
// outside the repo — `bunx serve` there resolves nothing locally and downloads
// the package on every cold run. Point it at the devDependency instead, so the
// service reaching `ready` (part of the snapshot key) needs no network. The
// command itself is not hashed; only the service's description and status are.
const SERVE_BIN = fileURLToPath(import.meta.resolve('serve/build/main.js'))

const testPreset = {
	...appBuilderPreset,
	orchestrator: {
		...appBuilderPreset.orchestrator,
		services: appBuilderPreset.orchestrator.services?.map((service) =>
			service.type === 'dev'
				? { ...service, command: ({ port }: { port: number }) => `bun ${SERVE_BIN} -l ${port} .` }
				: service,
		),
	},
}

// The directory listing the agent is primed with reports every file's size, and
// the session log's size depends on how much the run happened to log — it moved
// between this machine and CI and busted the key. `formatSize` is the only
// numeric token left in the digest that the environment gets to decide.
const stripFileSizes = (text: string) => text.replace(/\((?:\d+B|\d+\.\d+(?:KB|MB))\)/g, '(__SIZE__)')
const normalizeRequest = normalizeWith(composeStrippers(stripUuids, stripEphemeralPorts, stripFileSizes))

const hasApiKey = !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENROUTER_API_KEY
const hasSnapshots =
	existsSync(SNAPSHOTS_DIR) && readdirSync(SNAPSHOTS_DIR).some((f) => f.endsWith('.json'))
const recordSnapshots = process.env.ROJ_E2E_RECORD === '1'
if (recordSnapshots && !hasApiKey) {
	throw new Error('ROJ_E2E_RECORD=1 requires ANTHROPIC_API_KEY or OPENROUTER_API_KEY')
}
const canRunBuildTurn = recordSnapshots || (process.env.LIVE_TESTS === '1' && hasSnapshots)

describe('App Builder e2e', () => {
	let handle: StandaloneHandle
	let client: ReturnType<typeof createRojClient>

	beforeAll(async () => {
		mkdirSync(SNAPSHOTS_DIR, { recursive: true })
		rmSync(DATA_DIR, { recursive: true, force: true })
		mkdirSync(DATA_DIR, { recursive: true })
		rmSync(WORKSPACE_DIR, { recursive: true, force: true })
		mkdirSync(WORKSPACE_DIR, { recursive: true })

		handle = await startStandaloneServer({
			presets: [testPreset],
			config: {
				port: 0,
				host: '127.0.0.1',
				persistence: 'memory',
				dataPath: DATA_DIR,
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
					// Strip everything the run gets to decide — session UUIDs, the
					// dev-service port, file sizes — before hashing.
					normalize: normalizeRequest,
					mode: recordSnapshots ? 'record' : 'replay',
				}),
			],
		})

		client = createRojClient({ url: `http://127.0.0.1:${handle.port}`, apiKey: '' })
	})

	afterAll(async () => {
		await handle?.shutdown()
		rmSync(DATA_DIR, { recursive: true, force: true })
		rmSync(WORKSPACE_DIR, { recursive: true, force: true })
	})

	test('server exposes platform REST surface', async () => {
		const health = await fetch(`http://127.0.0.1:${handle.port}/health`)
		expect(health.status).toBe(200)

		const listed = await client.instances.list()
		expect(listed.instances.length).toBe(1)
		expect(listed.instances[0].instanceId).toBe(handle.instance.id)
	})

	test.skipIf(!canRunBuildTurn)('session completes a simple build turn', async () => {
		const created = await handle.sessionManager.createSession('app-builder', { workspaceDir: WORKSPACE_DIR })
		if (!created.ok) throw new Error(`createSession failed: ${created.error.message}`)
		const sessionId = String(created.value.id)

		// Send the initial prompt over the platform RPC surface (instance-scoped path).
		const sendResp = await fetch(
			`http://127.0.0.1:${handle.port}/api/v1/instances/${handle.instance.id}/rpc`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'user-chat.sendMessage',
					input: {
						sessionId,
						content: 'Create an index.html file with the text "Hello from roj".',
					},
				}),
			},
		)
		expect(sendResp.status).toBe(200)
		const sendBody = (await sendResp.json()) as { ok: boolean; error?: { message: string } }
		if (!sendBody.ok) throw new Error(`sendMessage failed: ${sendBody.error?.message}`)

		await waitForAllAgentsIdle(created.value, { timeoutMs: 120_000 })

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
