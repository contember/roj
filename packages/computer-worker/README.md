# @roj-ai/computer-worker

Private harness proving `@roj-ai/sdk` runs inside a Worker isolate, with a
[`@cloudflare/computer`](https://github.com/cloudflare/computer) workspace as
its filesystem. Not published.

```bash
bun run dev                     # wrangler dev on :8787
curl localhost:8787/run         # boot the SDK, run a two-agent session
curl localhost:8787/bench       # replay scaling: ?counts=100,500,1000,5000,10000
```

A `RojAgentDO` Durable Object owns one `Workspace`. `createComputerPlatform`
turns the workspace's `SQLiteWorkspaceProvider` into a roj `Platform`, which
goes into the SDK's normal composition root (`bootstrap` →
`createSystemFromServices`). A scripted LLM makes the orchestrator spawn a
`writer` agent, which writes a file via the filesystem plugin. The response
reports timings, the event count, and the resulting workspace tree.

## What this harness pins down

- The SDK boots and runs in workerd under `nodejs_compat` — no source changes
  beyond narrowing `FileSystem.open()` to `ReadableFileHandle`.
- Event sourcing persists: events land in `events.jsonl` through the adapter's
  `appendFile`, which upstream rejects with ENOSYS (see `computer-platform`).
- DO state survives isolate restarts — earlier sessions stay in the tree.

## Known gaps

- **`loadConfig()` is unusable.** It reads `process.env` and `process.cwd()`.
  This harness passes a `Config` literal instead.
- **Non-sandboxed presets don't work.** Relative agent paths resolve against
  `process.cwd()`, which a Worker isolate has no meaningful value for. The
  preset sets `sandboxed: true` so agents use virtual paths.
- **This harness still bootstraps the full plugin profile.** `services`,
  `resources`, `uploads` and `git-status` all need a process table, and
  `git-status` shells out to `git` every 2s, so it warns on a loop. Passing
  `{ pluginProfile: 'isolate' }` to `bootstrap()` drops all four; wiring that up
  is pending.
- **The `shell` and `snapshotting` plugins are a preset concern, not a profile
  one.** They register through `preset.plugins`, which a bootstrap profile has no
  reach into.
- **CPU under streaming inference is unmeasured.** The smoke run is ~1.6s wall,
  almost all of it agent debounce. There is no API key in the dev environment,
  so real inference has not been run in an isolate.

## Replay scaling (`/bench`)

Seeds a session with N synthetic events written straight to the `EventStore`,
then times `SessionManager.getSession` on a manager that has never seen it.
`wrangler dev` numbers on an 8-vCPU dev box, `cpu_ms` not enforced locally:

| events | log | `EventStore.load` | core reducer | cold `getSession` | warm |
|---:|---:|---:|---:|---:|---:|
| 100 | 28 KB | 1 ms | <1 ms | 55 ms | 0 ms |
| 1 000 | 290 KB | 3 ms | 1 ms | 66 ms | 0 ms |
| 10 000 | 2.9 MB | 19 ms | 24 ms | 144 ms | 0 ms |
| 100 000 | 29 MB | 294 ms | 1 532 ms | 1 867 ms | 0 ms |
| 350 000 | 102 MB | 1 110 ms | 34 645 ms | 38 008 ms | 0 ms |

Replay is linear to ~20 000 events, then the reducer's copy-on-append
(`conversationHistory`, `agents` Map, `state` spread — one full copy per event)
turns quadratic and worse. 30 s lands at roughly 320 000 events. A turn costs
~6 events, so this is orders of magnitude beyond any realistic session.

Note that `SessionManager.loadSession` calls `EventStore.load` twice — once to
read the `presetId`, once inside `SessionStore.load`. Cheap to fix, and it is
the whole of the I/O cost at small N.
