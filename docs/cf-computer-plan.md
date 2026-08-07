# Running roj on @cloudflare/computer

Moving the roj agent runtime from a Bun process in an E2B sandbox to a Worker
isolate backed by a [`@cloudflare/computer`](https://github.com/cloudflare/computer)
workspace.

Living document: phases carry their status and, where measurement contradicted
the original plan, what actually turned out to be true. Runnable evidence lives
in `packages/computer-worker/README.md`.

## Why

Today an agent session needs a live E2B VM. The VM holds the filesystem, so it
must stay up for the session to survive. Computer inverts this: the filesystem is
SQLite inside a Durable Object and is authoritative, while compute is ephemeral.
A session's state outlives every isolate that touches it.

The trade is that a Worker isolate has no process table. Everything roj does by
shelling out has to move, be dropped, or be routed to a container.

## Status

| Phase | State | Notes |
|---|---|---|
| 0 — measure | **done, verdict go** | Replay is not the risk. Inference CPU still unmeasured. |
| 1 — plugin profiles | **done** | `bootstrap(..., { pluginProfile: 'isolate' })` |
| 2 — SqliteEventStore | **done** | Wins on writes, not on reads — see below |
| 3 — `execFile` over shell | **done** | `spawn` deliberately still ENOSYS |
| 4 — git | **done** | Optional `git` port on `Platform` |
| 5 — transport in the DO | **done** | Workers WebSocket platform + DO wiring, hibernation proven |
| 6 — roj-platform | deferred | Shape decided; integration deliberately not started |
| 7 — limits | in flight | What standalone roj costs a Worker, and where it stops |
| 8 — scheduler port | next | The agent loop's `setTimeout` has no durability on CF |

## Phase 0 — measured, verdict: go

Replay was the half measurable without a deploy: rehydration reduces the whole
event log with no network in between, so wall time is a sound proxy for CPU.

Linear to ~20 000 events, then quadratic, reaching 30 s at roughly 320 000. A
turn costs ~6 events, so a 20-turn session is ~250 and replays in well under
150 ms — most of that fixed session construction, not replay. **The exit
criterion clears by three orders of magnitude.**

The quadratic term was diagnosed and the first guess was half wrong. It is
`conversationHistory`, copied whole on every `inference_completed`. The `agents`
Map copy and the `{...state}` spread are constant factors, not scaling terms.
Two growth sites the benchmark never exercised would add more of the same in a
real session: `mailbox` (never shrinks — consumption only flags `consumed: true`)
and `user-chat`.

Not worth fixing. Snapshots are the only remedy that does not put event-sourcing
correctness at stake, and `context-compact` already bounds `conversationHistory`
in practice.

**Still unmeasured: CPU under streaming inference.** No API key and no wrangler
auth in this environment, and reading real `cpu_ms` needs a deploy. This is the
one open risk in Phase 0.

## Phase 1 — plugin profiles

`BuiltinMethodSchemas` is inferred from the built-in plugin array and flows into
every client's RPC types, so the set could not simply become configurable. The
contract stays pinned to the full set; only *registration* is a runtime choice.
`isolatePlugins` is declared `satisfies` a subset of `fullPlugins`, so it cannot
name a plugin the contract does not know.

The isolate profile drops `services`, `resources`, `uploads` and `git-status`.

Correction to the original plan: **`shell` and `snapshotting` are not in scope
for a profile.** Neither was ever a built-in — they register through
`preset.plugins`, which a bootstrap profile has no reach into. Deselecting them
is a preset-authoring concern.

## Phase 2 — SqliteEventStore

The plan predicted wins on both writes and reads. **Only writes materialised.**

- **Writes: decisive.** A single append is under 1 ms at every log length; the
  file store pays ~12 ms, because it `lstat`s and rewrites the tail through the
  VFS each time. Batched, SQLite is 3–5× cheaper per event.
- **Reads: a wash.** `JSON.parse` plus zod validation dominates and both stores
  pay it identically; rows add overhead that cancels the file read they save.
- **"Indexed `loadRange`" never materialised.** `FileEventStore.loadRange`
  already reads only the tail of the file. Both answer a poller in under 4 ms at
  every size.

So the store belongs in an isolate for the write path, which is what an
event-sourced session does all day — not to make session load faster.

One bug worth remembering: a Durable Object binds at most **100 parameters per
statement**. At three per event that is 33 events; the first implementation
inserted a whole batch in one statement and silently worked in tests, because the
`bun:sqlite` fake allows ~32 000. Fakes that are more permissive than production
hide exactly this class of bug.

## Phase 3 — `execFile` over the isolate shell backend

`execFile` buffers and resolves, which maps onto `workspace.runtime.exec(...)`
plus `result()`. `spawn` returns a Node `ChildProcess` and stays ENOSYS; only
`services` needs it.

Wiring took four things, one of them undocumented upstream:

1. `worker_loaders: [{ binding: "LOADER" }]`
2. the `experimental` compatibility flag, which gates it
3. **`enable_ctx_exports`** — without it `ctx.exports` is `undefined` and every
   exec dies reaching for `WorkspaceServiceProxy`
4. that proxy re-exported from the worker's main module, plus
   `__getWorkspaceStub()` on the DO (upstream's `withWorkspace` mixin supplies
   it; a directly-constructed `Workspace` does not)

`just-bash` implements more than expected — `grep`, `sed`, `awk`, `find`, `jq`,
`sqlite3`, `tar`, pipes, redirects, `$(...)`, globs, loops. It does not implement
`node`, `unzip`, `pdftotext`, `python3` or `curl`, so every upload preprocessor
still needs the container backend or a rewrite. Full probe results are in the
harness README.

## Phase 4 — git

`git` is an *optional* capability on `Platform` (`git?: GitClient`). Uniform with
`fs` and `process`; hosts that cannot do git omit it. `git-status` reads the port
and degrades quietly when it is absent, so it moved back into the isolate
profile. `bun-platform` is unchanged — the point of the `?`.

The port has four methods, each derived from a call `git-status` actually makes,
not from what git can do: `status`, `log`, `countAhead`, `defaultBranch`.

Two corrections to what this plan originally claimed:

- **The new dependency is not `isomorphic-git`.** It is already bundled inside
  `@cloudflare/computer`; what `@roj-ai/computer-platform` actually pulls in is
  `@platformatic/vfs`.
- **`defaultBranch` can never answer in an isolate.** computer's `symbolic-ref`
  accepts only `HEAD`, so `refs/remotes/origin/HEAD` exits 129. The port returns
  `undefined` for "unknown" and the caller keeps its own fallback, rather than
  inventing an answer.

`snapshotting` uses the `jj` binary and has no equivalent. It stays out.

## Phase 5 — transport in the DO

**SDK half done.** `AppServices` is generic over the plugin profile, defaulting
to `full`, so the Hono app mounts over either. `@roj-ai/transport/workers` adapts
DO hibernation WebSockets, with two things workerd does not provide emulated:
pub/sub (topics live in an in-memory registry — hibernation tags are fixed at
accept time and cannot express a dynamic `subscribe()`), and continuity across
eviction (`restore(state.getWebSockets())` rebuilds the tree on wake).

Two findings worth keeping:

- **No client factory for workerd.** Its `WebSocket` extends `EventTarget` and
  has no `onmessage`/`onclose` properties at all, so `browserWebSocketFactory`
  type-checks against the ambient Bun `WebSocket` and is wrong at runtime. A DO
  that dials out needs a separate `addEventListener`-based factory.
- **`IWebSocketServer.upgrade` cannot work in Workers** — an upgrade must return
  a 101 carrying the client half of a `WebSocketPair`, not a boolean. It is dead
  code, implemented by no platform including Bun.

**DO half done.** `createDoTransport` mounts `createApp`, upgrades `/ws` before
`acceptWebSocket`, and forwards `webSocketMessage`/`Close`/`Error` into the
handlers. `restore(ctx.getWebSockets())` runs in the factory, and a socket
opened before an isolate eviction still receives notifications after it.

Four findings about `createApp` under workerd, none of them blocking:

- `node:path` is imported at module scope; the app loads only because of
  `nodejs_compat`.
- Upload and resource routes mount unconditionally, so under the isolate profile
  they fail at request time rather than 404.
- `/status` under-reports after eviction — `getStats` walks in-memory sessions only.
- Without an `agentToken`, `/rpc` is open.

Open behaviour question, still open: an in-flight LLM stream does not survive DO
eviction. Event sourcing restores state, not a half-finished inference. Either
hold the DO with a WebSocket, or make inference resumable.

## Phase 6 — roj-platform (deferred)

Today: `RojProjectDO` → `SandboxClient` → HTTP RPC → E2B agent server. The client
is typed against `@roj-ai/sdk/rpc`, so the RPC surface is already the contract;
the move is to implement it in-process instead of over the network.

**Shape decided: routed per agent type.** An agent that needs the full power of a
container keeps running on E2B; one that fits an isolate takes the cheaper DO
path. So this is a hybrid, but the selector is the agent type rather than a
per-capability split, and neither backend has to grow into the other.

**Integration deliberately not started.** The current subject is standalone roj
inside a Worker and where it stops — Phase 7.

## Phase 7 — limits

What one Worker costs roj, measured rather than quoted. `/limits/<name>` routes
to one probe per file under `packages/computer-worker/src/limits/`, each on its
own DO so a probe that OOMs or fills storage cannot poison the next.

Settled so far, all locally and without a deploy:

- **Script size: 7.2 MB raw / 1.57 MB gzip.** Fits the 10 MB paid ceiling with
  room, and even the 3 MB free one.
- **Startup CPU: ~103 ms of the 400 ms budget** (`wrangler check startup`).
  Attributed by difference across three minimal Workers: baseline 23.5 ms, plus
  ~55 ms for `@roj-ai/sdk` (1.1 MB) and ~23 ms for `@cloudflare/computer`
  (5.9 MB). Bytes do not predict startup — module-scope work does, and the SDK's
  is zod schema construction. Cloudflare's CPU differs from a dev box, so treat
  this as a magnitude, not as headroom.

## Phase 8 — scheduler port

`Agent.scheduleProcessing` re-enters through `setTimeout` (500 ms debounce), and
nothing in the harness or the transport calls `waitUntil` or sets an alarm. A
Worker keeps an isolate alive for a request in flight, a pending `waitUntil`, or
an attached non-hibernated socket — a bare timer buys none of those. Locally the
loop still finishes, because a dev server does not evict; that is exactly the
class of bug that only appears in production.

The SDK's timers split cleanly in two:

| Class | Sites | Needs a port? |
|---|---|---|
| Timeout inside a call in flight | `anthropic`/`openrouter` fetch abort, `retry.ts` backoff sleep, `workers` 5 s shutdown race | No — the invocation is alive because something awaits it |
| "Wake me later" | `agent.debounceTimer`, `agent.errorRetryTimer`, `agents.scheduleSupervisionTick`, `git-status` poll interval | **Yes** |

Every one of the four in the second class is *wake this agent and let it
recompute*, not *run this closure*: they call `continue()`, `scheduleProcessing()`,
`trigger(agentId)` and `tick()` respectively, and none carries data in its
closure. So the port does not have to serialise anything.

**Decided shape:**

```ts
export interface Scheduler {
	/** Wake `key` after `delayMs`. Replaces any pending wake for it. */
	wake(key: string, delayMs: number): Promise<void>
	cancel(key: string): Promise<void>
}
```

Bun implements it with `setTimeout` and behaves as it does today. The CF
implementation sets a DO alarm; the alarm handler boots and re-enters the keyed
agent, which is what makes it survive eviction.

## Open decisions

**`spawn` shim.** A `ChildProcess`-shaped wrapper over exec handles would let
`services` run in an isolate. Under per-agent-type routing an agent that needs
long-running processes can simply be routed to E2B instead, so this is now a
convenience rather than a prerequisite.

## Upstream issues to file

- `SQLStorageLike.exec<Row extends object>` cannot be satisfied by
  `workers-types` `exec<T extends Record<string, SqlStorageValue>>`. The
  parameter is phantom at runtime; the harness bridges it with one cast.
- `SQLiteWorkspaceProvider.appendFile` and `copyFile` reject with ENOSYS.
  `appendFile` in particular is what an event log wants.
- `enable_ctx_exports` is required for `WorkerShellBackend` and is documented
  nowhere; the failure mode is an undefined `ctx.exports`.
