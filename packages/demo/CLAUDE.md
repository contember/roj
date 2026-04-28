# Demo Package

End-to-end showcase of the roj stack via `@roj-ai/standalone-server`. Hosts
the App Builder preset behind a local Bun API server; a Vite React SPA
consumes it with the same hooks real users would use.

**Not published.** Consumed only by developers and the e2e test.

## Dual purpose

1. **Manual demo** — `bun run dev` to try the full stack in a browser.
2. **E2E test** (`tests/app-builder.e2e.test.ts`) — spins up the real server,
   talks to it over REST+WS, snapshots LLM calls so CI can replay deterministically.

## Key files

- `agent/preset.ts` — App Builder preset. Uses `claude-haiku-4-5-20251001` (cheap
  recording). `filesystemPlugin` + `shellPlugin`, dev service via `bunx serve`.
- `server.ts` — thin launcher around `startStandaloneServer({ presets: [...] })`.
- `spa/App.tsx` — landing form → `useChat()` workspace. Talks to standalone
  REST at `PLATFORM_URL` (derived from `window.location`, port 2486).
- `tests/app-builder.e2e.test.ts` — runs on port 0, uses
  `createSnapshotLLMMiddleware` for deterministic LLM. Test skips the live-turn
  assertion when neither `ANTHROPIC_API_KEY` nor snapshots are present.

## Snapshot workflow

```bash
# Record (local, once)
ANTHROPIC_API_KEY=sk-... bun test packages/demo/tests/

# Replay (CI, default)
bun test packages/demo/tests/
```

Snapshot files are keyed by SHA-256 of the normalized `InferenceRequest`.
Any change to the preset (system prompt, model, tools) invalidates them.

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
