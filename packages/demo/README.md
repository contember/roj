# @roj-ai/demo

Minimal end-to-end demo of the roj stack: an **App Builder** preset served
through **@roj-ai/standalone-server**, consumed by a **React SPA** using
`@roj-ai/client-react` hooks.

Not published to npm — this package is a local-only example and e2e test bed.

## Running the demo

```bash
# 1. Provide an LLM key (Anthropic or OpenRouter)
export ANTHROPIC_API_KEY=sk-ant-...

# Requires two terminals (no concurrently-runner dependency)

# Terminal 1 — API server on :2486 (reads ../../.env automatically)
bun run --filter @roj-ai/demo dev:server

# Terminal 2 — SPA on :2487
bun run --filter @roj-ai/demo dev:spa

# Open http://localhost:2487
```

The SPA calls the standalone REST API on `:2486` directly (no backend in
between). On submit it creates an instance + session and connects via
WebSocket. The preset's agent creates plain HTML/CSS/JS files; the `dev`
service auto-starts and the preview iframe loads via the standalone's
preview proxy.

## E2E test

`tests/app-builder.e2e.test.ts` starts the full standalone server on an
OS-assigned port, creates a session, sends a message, and asserts the
session reaches idle. LLM calls are snapshotted via
`createSnapshotLLMMiddleware` — the first run records, subsequent runs
replay from disk.

```bash
# Record snapshots (first time, or after preset changes)
ROJ_E2E_RECORD=1 OPENROUTER_API_KEY=sk-or-... bun test packages/demo/tests/
# or with Anthropic directly
ROJ_E2E_RECORD=1 ANTHROPIC_API_KEY=sk-ant-... bun test packages/demo/tests/

# Replay (CI, default — no network, strict replay once snapshots exist)
bun test packages/demo/tests/
```

Commit `tests/__snapshots__/app-builder/` so CI can replay without an API key.
When the preset prompt/tools/model change, re-record with `ROJ_E2E_RECORD=1`
(or just delete the affected snapshot files and let the next run
auto-record against the live API).

### How deterministic is it?

The middleware keys snapshots by SHA-256 of the normalized `InferenceRequest`
(sorted keys, tool schemas reduced to name+description, metadata fields
like `timestamp`/`isError`/`sourceMessageIds` stripped). The test also
applies `normalizeStripRuntime` to strip run-local data (session UUIDs,
ephemeral ports) from prompts before hashing.

Things that (correctly) invalidate a snapshot:

- Prompt/system change, model ID change, temperature change.
- Adding/removing tools; renaming a tool.

### Why the workspace path is pinned

The cached LLM response contains whatever path the agent saw at record
time. If the path varies per run (e.g. a `{sessionId}` template in
`workspaceDir`), replay will hand the filesystem plugin paths that don't
exist for the current session and the turn fails. The test overrides the
preset's `workspaceDir` to a fixed `/tmp/roj-demo-e2e` to sidestep this.
The real preset (used in `bun run dev`) keeps the templated path — it
only matters for snapshot-based tests.

## Layout

```
agent/
  preset.ts        # App Builder preset (Haiku, filesystem + shell plugins)
  roj.config.ts    # defineConfig wrapper for standalone-server CLI use
server.ts          # startStandaloneServer launcher (`bun run dev:server`)
spa/
  App.tsx          # Landing (textarea) + Workspace (chat + preview iframe)
  vite.config.ts
tests/
  app-builder.e2e.test.ts
  __snapshots__/app-builder/*.json   # one file per unique LLM request
```
