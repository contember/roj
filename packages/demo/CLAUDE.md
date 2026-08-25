# Demo Package

End-to-end showcase of the roj stack via `@roj-ai/standalone-server`. Hosts
the App Builder preset behind a local Bun API server; a Vite React SPA
consumes it with the same hooks real users would use.

**Not published.** Consumed only by developers and the e2e test.

## Dual purpose

1. **Manual demo** — `bun run dev` to try the full stack in a browser.
2. **E2E tests** —
   - `tests/app-builder.e2e.test.ts` always checks the REST surface;
     record/replay modes exercise the LLM-backed build turn. CI replays it.
   - `tests/eviction-round-trip.e2e.test.ts` drives a session through runtime
     eviction and back over REST. Stubs the LLM in middleware, so it needs no
     key and no snapshots, and runs in the default `bun run test`.

## Key files

- `agent/preset.ts` — App Builder preset. Uses `claude-haiku-4-5-20251001` (cheap
  recording). `filesystemPlugin` + `shellPlugin`, dev service via `bunx serve`.
- `server.ts` — thin launcher around `startStandaloneServer({ presets: [...] })`.
- `spa/App.tsx` — landing form → `useChat()` workspace. Talks to standalone
  REST at `PLATFORM_URL` (derived from `window.location`, port 2486).
- `tests/app-builder.e2e.test.ts` — runs on port 0 and uses
  `createSnapshotLLMMiddleware`. The REST smoke test always runs. Recording the
  build turn needs `ROJ_E2E_RECORD=1` plus a key; replay needs `LIVE_TESTS=1`
  plus committed snapshots and never calls the provider.
- `tests/eviction-round-trip.e2e.test.ts` — own server on its own data root with
  a sub-second `sessionIdleTimeoutMs`. Asserts the chat projection a client
  reads over REST is byte-identical before and after the runtime is evicted.

## Snapshot workflow

```bash
# Record or refresh snapshots
ROJ_E2E_RECORD=1 ANTHROPIC_API_KEY=sk-... bun test packages/demo/tests/

# Replay the build turn without network access
LIVE_TESTS=1 bun test packages/demo/tests/

# REST smoke + eviction round trip (what `bun run test` runs)
bun test packages/demo/tests/
```

Snapshot files are keyed by SHA-256 of the normalized `InferenceRequest`.
Any change to the preset (system prompt, model, tools) invalidates them.

**The workspace path must be identical on every run.** The recorded assistant
turn carries a `write_file` call with the absolute path it saw while recording,
so a per-session directory makes every snapshot dead on arrival — the replayed
write lands outside the new session's workspace and the agent never settles.
Platform REST `sessions.create` mints its own UUID and puts the session in a git
worktree, so the build turn creates its session through `handle.sessionManager`
with a fixed `/tmp/roj-demo-e2e` workspace. REST `sessions.create` is covered by
the eviction e2e instead.

**The dev service status is part of the key too** (`— ready (port __PORT__)`), so
the service has to reach `ready` on replay as well. The test points it at the
`serve` devDependency rather than `bunx serve`, which would download the package
from inside the session workspace on every cold run.

## Ports

- Standalone API: `2486` (PORT env override)
- Vite SPA: `2487`

The SPA doesn't proxy — it calls `http://<host>:2486` directly (CORS is open).

## Porting notes (vs. roj-platform/packages/demo)

The upstream demo in `roj-platform` is richer (SCORM preset, file upload,
Hub view, projects list). This OSS demo is deliberately minimal:

- **Kept**: App Builder preset, chat UI, preview iframe, platform REST/WS
  path via `@roj-ai/client` + `@roj-ai/client-react`.
- **Dropped**: SCORM, file upload, resources, `autoCreateSession`,
  multi-project Hub. The standalone server returns `method_not_found` for
  those.
- **Changed**: model default `claude-sonnet-4-6` → `claude-haiku-4-5-20251001`
  (cheaper to record snapshots).
