# Running roj on @cloudflare/computer

Plan for moving the roj agent runtime from a Bun process in an E2B sandbox to a
Worker isolate backed by a [`@cloudflare/computer`](https://github.com/cloudflare/computer)
workspace.

Status: feasibility proven by the spike on branch `cf-computer`. See
`packages/computer-worker/README.md` for what the spike does and measures.

## Why

Today an agent session needs a live E2B VM. The VM holds the filesystem, so it
must stay up for the session to survive. Computer inverts this: the filesystem
is SQLite inside a Durable Object and is authoritative, while compute is
ephemeral. A session's state outlives every isolate that touches it.

The trade is that a Worker isolate has no process table. Everything roj does by
shelling out has to move, be dropped, or be routed to a container.

## What the spike established

| Claim | Evidence |
|---|---|
| SDK boots and runs in workerd | `bootstrap` → `createSystemFromServices` → 2-agent session, 5 consecutive runs |
| The `Platform` seam is sufficient | One adapter, one narrowed interface (`FileSystem.open`), no other SDK source change |
| Event sourcing persists over the VFS | 25 events in `events.jsonl` per run, via an `appendFile` the provider rejects |
| DO state survives isolate restarts | Prior sessions still in the tree after reload |
| LLM path is portable | Providers are `fetch`-based; deps are `hono`, `ignore`, `tokenx`, `uuidv7`, `zod` |

What it did **not** establish: CPU headroom. The smoke run is ~1.6s wall, almost
entirely agent debounce. It says nothing about streaming inference or replaying a
long event log.

## Phases

### Phase 0 — Measure CPU, then decide (blocking)

Everything below assumes a Worker isolate can carry a real session. That is
unproven and cheap to test. Do not start Phase 1 before this returns.

- Point the harness at a real Anthropic provider instead of the scripted mock.
- Run one agent through a multi-turn task with tool calls.
- Instrument two numbers: CPU per inference turn, and replay cost as a function
  of event count (seed 100 / 1 000 / 10 000 events, measure `SessionManager.getSession`).
- Deploy to a real account — `wrangler dev` does not report CPU time. Observability
  logs do.

Deliverables: go/no-go, and whether `limits.cpu_ms` above the default is required.

**Exit criterion:** a 20-turn session replays and runs without hitting a CPU
limit at `cpu_ms: 30000`. If it needs more than 300 s, the isolate path is dead
for long sessions and the container backend is the only option.

Estimate: 1–2 days.

### Phase 1 — Plugin profiles

The blocker found by the spike. `builtinPlugins` in `bootstrap.ts` is a hardcoded
`const` array, and `BuiltinMethodSchemas = AllMethodSchemas<typeof builtinPlugins>`
flows through `transport/rpc/methods.ts` into `packages/shared/src/rpc/client.ts`
and `packages/client/src/api/client.ts`. Removing a plugin changes every client's
types.

Design: keep `RpcMethods` derived from the **full** plugin set so client types are
unchanged, and make registration a runtime choice. An isolate profile simply does
not register `services`, `resources`, `uploads`, `shell` and `git-status`; calling
one of their methods returns a normal method-not-found error.

- `bootstrap.ts` — export `fullPlugins` and `isolatePlugins`; `bootstrap()` takes
  a profile, defaulting to `full`.
- `core/system.ts` — no change if `RpcMethods` keeps deriving from `fullPlugins`.
- `testing/test-harness.ts` — currently copy-pastes the same list as
  `defaultSystemPlugins`. Collapse both onto one source.

Removes the `git-status: snapshot failed` poll loop the spike hit every 2 s.

Estimate: 2–3 days.

### Phase 2 — SqliteEventStore

`FileEventStore` works over the VFS but every append rewrites a JSONL blob
through SQLite, and `load` reads the whole file. A real table gives indexed
`loadRange` and cheap metadata.

`BaseEventStore` is a clean 8-method abstract (`doAppend`, `doAppendBatch`,
`load`, `loadRange`, `exists`, `listSessions`, `readMetadata`, `writeMetadata`,
`getAllSessionMetadata`) — a well-bounded implementation target.

It is **not exported** today, from either `core/events/index.ts` or the package
root. Exporting it is a prerequisite.

→ Decision needed: see "Where SQLite-backed code lives" below.

Estimate: 1–2 days.

### Phase 3 — execFile over the isolate shell backend

`ProcessRunner` has two methods with very different costs.

`execFile` buffers and resolves — it maps almost directly onto
`workspace.runtime.exec(cmd, { backend: 'shell' })` plus `result()`. That unblocks
`resources`, the upload preprocessors, and anything that just wants stdout.

`spawn` returns a Node `ChildProcess` — streams, `kill()`, `'exit'` events. A shim
over the exec handle is real work and only the `services` plugin needs it. Keep it
ENOSYS for now.

Requires the `worker_loaders` binding and the `experimental` compatibility flag.
Note that `just-bash` implements a subset of shell — commands will need auditing,
not assuming.

Estimate: 2 days for `execFile`. The `spawn` shim is a separate 3–4 days; defer.

### Phase 4 — git over workspace.git

`git-status` shells out to the `git` binary. Computer ships a `GitClient`
(`workspace.git`) that works directly against the VFS, so the plugin can be
rewritten rather than dropped.

→ Decision needed: `Platform` today is `{ fs, process, tmpDir }`. Adding a `git`
port changes a published interface and affects `bun-platform`. The alternative is
injecting a git client at plugin config level. This is an architecture call, not
mine to make.

The `snapshotting` plugin uses the `jj` binary and has no equivalent. It stays out
of the isolate profile.

Estimate: 1–2 days once the shape is decided.

### Phase 5 — Transport inside the DO

`transport/http/app.ts` is Hono, which runs on Workers unmodified. Mount
`createApp(services)` in `DurableObject.fetch` and `/rpc` works.

Two knowns:
- `ws` is in `packages/sdk` dependencies but **imported nowhere in `src`**. It is
  a stale dep; drop it rather than porting it.
- `packages/transport` already splits platforms (`platform/browser.ts`,
  `platform/bun.ts`). A `platform/workers.ts` using the DO hibernation WebSocket
  API follows the existing pattern.

Open behaviour question: an in-flight LLM stream does not survive DO eviction.
Event sourcing restores state, not a half-finished inference. Either hold the DO
with a WebSocket, or make inference resumable. Decide with Phase 0's numbers in
hand.

Estimate: 2–3 days.

### Phase 6 — Integrate into roj-platform

Today: `RojProjectDO` → `SandboxClient` → HTTP RPC → E2B agent server. The client
is typed against `@roj-ai/sdk/rpc`, so the RPC surface is already the contract.

The move is to implement that same surface in-process instead of over HTTP.
`SandboxClient`'s shape stays; a sibling implementation drops the network hop.

→ Depends on the scope decision below.

Estimate: 3–5 days.

## Decision points

These change what gets built. None are mine to settle.

**Where SQLite-backed code lives.** `@roj-ai/sdk` currently has no Cloudflare
dependency, and its consumers are Bun users. A `SqliteEventStore` could go in the
SDK (needs `BaseEventStore` exported either way), or in `@roj-ai/computer-platform`
alongside the fs adapter. The latter keeps the SDK clean; the former makes it
reusable for any SQLite host.

**Target shape.** Replace E2B outright, or run a hybrid — isolate for filesystem
and tools, container backend for `npm install` and dev servers. Hybrid is what
computer is designed for and keeps `services` alive, but means operating both.
Outright replacement is simpler and drops every process-dependent plugin.

**The `git` port.** Extend `Platform` with a `git` capability, or inject a client
per plugin. The first is cleaner and touches a published interface; the second is
contained and less uniform.

**`spawn` shim.** Build the `ChildProcess`-shaped wrapper over exec handles so
`services` works in an isolate, or accept that dev servers need the container
backend. Only worth it if the answer to "target shape" is outright replacement.

## Risks

| Risk | Detection | Mitigation |
|---|---|---|
| CPU limit under real inference | Phase 0 | `limits.cpu_ms`, or container backend |
| Replay cost grows with event log | Phase 0, seeded logs | Snapshotting / compaction already exists in `context-compact` |
| Eviction mid-inference | Phase 5 | Hold DO with WS, or resumable inference |
| `just-bash` subset breaks commands | Phase 3, audit | Route those to the container backend |
| Computer is preview-only | Upstream | APIs are explicitly unstable; pin the version |

## Upstream issues to file

- `SQLStorageLike.exec<Row extends object>` cannot be satisfied by
  `workers-types` `exec<T extends Record<string, SqlStorageValue>>`. The parameter
  is phantom at runtime; the spike bridges it with one cast.
- `SQLiteWorkspaceProvider.appendFile` and `copyFile` reject with ENOSYS.
  `appendFile` in particular is what an event log wants.

## Total

Phases 1–5, assuming Phase 0 says go: **8–12 working days**, plus Phase 6 for the
platform integration. The `spawn` shim and the container-backend hybrid are
separate tracks on top.
