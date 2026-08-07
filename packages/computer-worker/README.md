# @roj-ai/computer-worker

Private harness proving `@roj-ai/sdk` runs inside a Worker isolate, with a
[`@cloudflare/computer`](https://github.com/cloudflare/computer) workspace as
its filesystem. Not published.

```bash
bun run dev                     # wrangler dev on :8787
curl localhost:8787/run         # boot the SDK, run a two-agent session
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
- **`git-status` polls forever.** It shells out to `git` every 2s and the
  isolate ProcessRunner rejects with ENOSYS, so it warns on a loop. Built-in
  plugins are a hardcoded array in `bootstrap.ts`, so there is no way to
  deselect it yet — an "isolate profile" needs to exist first.
- **`services`, `resources`, `uploads` preprocessors and `shell`** all need a
  process table and will fail the same way when their tools are called.
- **CPU headroom is unmeasured.** The smoke run is ~1.6s wall, almost all of it
  agent debounce, and never approached a limit. It says nothing about a real
  session with streaming inference and a long event log to replay.
