# @roj-ai/computer-worker

Private harness proving `@roj-ai/sdk` runs inside a Worker isolate, with a
[`@cloudflare/computer`](https://github.com/cloudflare/computer) workspace as
its filesystem. Not published.

```bash
bun run dev                     # wrangler dev on :8787
curl localhost:8787/run         # boot the SDK, run a two-agent session
curl localhost:8787/bench       # replay scaling: ?counts=100,500&stores=sqlite,file
curl localhost:8787/shell       # probe what just-bash implements; ?cmd=... for one command
curl localhost:8787/git         # build a repo in a session workspace, read it back three ways
curl localhost:8787/limits      # roster; /limits/<name> runs one probe — see "Limits" below
```

A `RojAgentDO` Durable Object owns one `Workspace`. `createComputerPlatform`
turns the workspace's `SQLiteWorkspaceProvider` into a roj `Platform`, which
goes into the SDK's normal composition root (`bootstrap` →
`createSystemFromServices`) under the `isolate` plugin profile. A scripted LLM
makes the orchestrator spawn a `writer` agent, which writes a file via the
filesystem plugin. The response reports timings, the event count, and the
resulting workspace tree.

Five things the DO wires that the SDK's own defaults do not:

- **`{ pluginProfile: 'isolate' }`** — drops `services`, `resources` and
  `uploads`, the three built-ins that need a process table.
- **`createAlarmScheduler(ctx)`** as `Platform.scheduler`, in place of the SDK's
  default timers. Every debounce and retry hop of the agent loop then re-enters
  through `alarm()`, which is a *delivered* event — it tops the actor's CPU
  budget up, and it outlives the isolate that armed it. See "A turn across an
  alarm" below.
- **`SqliteEventStore`** over `ctx.storage`, replacing the `FileEventStore`
  `bootstrap()` builds off `config.persistence`. Swapped in on the `Services`
  object, since `Config` has no third persistence mode.
- **`WorkerShellBackend`** on the workspace, so `platform.process.execFile`
  runs commands instead of rejecting with ENOSYS.
- **`createGitClient()`** as `WorkspaceOptions.git`, which backs both the shell's
  `git` command and `platform.git`, plus a `defaultGitIdentity` so commits have
  an author. Without the factory the `git` getter throws and
  `createComputerPlatform` leaves `platform.git` unset.

## What this harness pins down

- The SDK boots and runs in workerd under `nodejs_compat` — no source changes
  beyond narrowing `FileSystem.open()` to `ReadableFileHandle`.
- Event sourcing persists, either into SQLite rows or into `events.jsonl`
  through the adapter's `appendFile`, which upstream rejects with ENOSYS.
- DO state survives isolate restarts — earlier sessions stay in the tree.
- `execFile` works over the shell backend; `spawn` does not (see below).
- Git runs with no binary and no process table. `/git` runs `git init`, `add`
  and `commit` through the shell, then reads the same repo back off
  `platform.git` and out of the `git-status` plugin's notification.

## Wiring the shell backend

`WorkerShellBackend` mints a Dynamic Worker running `just-bash` and hands it a
loopback binding that dials back into this DO for filesystem access. That needs
four things, all of them easy to miss:

1. `worker_loaders: [{ binding: "LOADER" }]` in `wrangler.jsonc`.
2. The `experimental` compatibility flag, which gates the loader binding.
3. The `enable_ctx_exports` compatibility flag. The backend reaches the proxy
   through `ctx.exports.WorkspaceServiceProxy(...)`; without the flag
   `ctx.exports` is `undefined` and every exec fails with
   `Cannot read properties of undefined (reading 'WorkspaceServiceProxy')`.
4. `WorkspaceServiceProxy` re-exported from the worker's main module, and an
   `__getWorkspaceStub()` method on the DO for the proxy to call. (The upstream
   `withWorkspace` mixin supplies the method; this harness constructs its
   `Workspace` directly and so supplies it itself.)

## Known gaps

- **`loadConfig()` is unusable.** It reads `process.env` and `process.cwd()`.
  This harness passes a `Config` literal instead.
- **Non-sandboxed presets don't work.** Relative agent paths resolve against
  `process.cwd()`, which a Worker isolate has no meaningful value for. The
  preset sets `sandboxed: true` so agents use virtual paths.
- **`spawn` is still ENOSYS.** It returns a Node `ChildProcess` — streams,
  `kill()`, `'exit'` — and only the `services` plugin needs it. `execFile` is
  routed; the `ChildProcess` shim is not built.
- **`platform.git.defaultBranch()` always answers "unknown" here.** computer's
  git cannot read a remote's HEAD — its `symbolic-ref` accepts only `HEAD` — so
  `git-status` compares against its own `main` fallback rather than whatever
  `origin/HEAD` points at.
- **The `shell` and `snapshotting` plugins are a preset concern, not a profile
  one.** They register through `preset.plugins`, which a bootstrap profile has
  no reach into.
- **CPU under streaming inference is unmeasured.** The smoke run is ~1.6s wall,
  almost all of it agent debounce. There is no API key in the dev environment,
  so real inference has not been run in an isolate. Everything roj does *around*
  the provider is measured — see Limits.

## What just-bash implements

`/shell` runs a fixed probe suite through both entry points —
`platform.process.execFile`, which quotes an argv back into a command line, and
a raw `runtime.exec` for the shell syntax `execFile` cannot express. Results
below are from that suite plus ad-hoc `?cmd=` probes; nothing here is inferred.

Works: `echo` `cat` `ls` (incl. `-la`) `pwd` `grep` (incl. `-r`) `rg` `head`
`tail` `wc` `sed` `awk` `cut` `sort` `xargs` `find` `tree` `mkdir` `cp` `mv`
`rm` `touch` `stat` `ln -s` `readlink` `tee` `printf` `paste` `date` `sleep`
`timeout` `env` `which` `type` `test` `sh -c` `bash -c`. `diff`, `tar`, `gzip`,
`jq` and `sqlite3` exist too, with their own flag surfaces (`--version` is not
one of them; a `diff` of differing files exits 1, as it should).

`git` works now that the workspace has a client — `init`, `add`, `commit`,
`log`, `status`, `diff`, `branch`, `checkout`, `rev-parse`, `remote`, `stash`,
`reset` and friends all dispatch into `workspace.git`. Three divergences from
the real binary, all measured:

| Divergence | Detail |
|---|---|
| `--porcelain` is v2 | Untracked paths come back as `? file`, not `?? file`. `--porcelain=v1` gives the two-char codes real git's plain `--porcelain` does. |
| `status` outside a repo succeeds | It reports every file untracked instead of failing. `log` and `rev-parse` do reject, which is what `git-status` keys off. |
| `symbolic-ref` only takes `HEAD` | `refs/remotes/origin/HEAD` exits 129, so remote default-branch detection is unavailable. |

Shell syntax works: pipes, `>` and `>>`, `<`, `&&` / `||` / `;`, `$(...)`,
`$((...))`, variable assignment and `export`, globs, `for`, `if [ ... ]`, `cd`,
background `&` with `wait`.

Does not work:

| Missing | Detail |
|---|---|
| `which git` | Fails even though `git` runs, because it is a host command with no path. `type git` and `command -v git` both answer `/usr/bin/git`. |
| `node`, `unzip`, `pdftotext` | `command not found`. |
| `python3` | `command not available in browser environments`. |
| `curl` | `command not found`, and the Dynamic Worker runs with `globalOutbound: null` anyway. |
| `trap` | `trap: command not found`. |

For roj that means `ZipPreprocessor` (`unzip`), `PdfPreprocessor` (`pdftotext`,
`pdfimages`), `MarkitdownPreprocessor` and `VipsImageResizer` (`vips*`) still
cannot run on this backend — they need the container backend, or a rewrite
against a workspace API. `git-status` no longer belongs on that list: it reads
`platform.git` rather than shelling out.

## Replay scaling (`/bench`)

Seeds a session with N synthetic events written straight to the `EventStore`,
then times `SessionManager.getSession` on a manager that has never seen it.
`?stores=sqlite,file` runs the same seed against both stores back to back.
`wrangler dev` under a 2-vCPU `cpu-lease` on an 8-vCPU dev box, `cpu_ms` not
enforced locally. `append/ev` is one event's share of an `appendBatch(100)`;
`append 1` is a single append at full log size.

| events | store | bytes | append/ev | append 1 | `load` | tail `loadRange` | core reducer | cold `getSession` | warm |
|---:|:--|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | sqlite | 28 KB | 0.047 ms | 0.8 ms | 0 ms | 0 ms | 1 ms | 19 ms | 0 ms |
| 100 | file | 28 KB | 0.174 ms | 11.9 ms | 1 ms | 1 ms | 0 ms | 155 ms | 0 ms |
| 1 000 | sqlite | 282 KB | 0.019 ms | 0.6 ms | 2 ms | 1 ms | 1 ms | 22 ms | 0 ms |
| 1 000 | file | 283 KB | 0.136 ms | 12.2 ms | 2 ms | 0 ms | 1 ms | 51 ms | 0 ms |
| 10 000 | sqlite | 2.8 MB | 0.016 ms | 0.8 ms | 28 ms | 0 ms | 21 ms | 72 ms | 0 ms |
| 10 000 | file | 2.8 MB | 0.116 ms | 11.3 ms | 24 ms | 2 ms | 15 ms | 88 ms | 0 ms |
| 100 000 | sqlite | 27.7 MB | 0.011 ms | 0.9 ms | 261 ms | 1 ms | 1 499 ms | 1 690 ms | 0 ms |
| 100 000 | file | 27.8 MB | 0.049 ms | 11.3 ms | 256 ms | 2 ms | 1 531 ms | 1 701 ms | 0 ms |
| 350 000 | sqlite | 97.2 MB | 0.007 ms | 0.8 ms | 1 001 ms | 1 ms | 23 389 ms | 25 227 ms | 0 ms |
| 350 000 | file | 97.5 MB | 0.036 ms | 12.2 ms | 939 ms | 4 ms | 32 289 ms | 34 706 ms | 0 ms |

Reading it:

- **Writes are where SQLite wins.** A single append costs SQLite under 1 ms at
  every log length; the file store costs ~12 ms, because every append `lstat`s
  the file and writes at its end through the VFS. Batched, SQLite is 3–5×
  cheaper per event.
- **`load` is a wash, and at 100 000+ SQLite is not ahead.** Reading the whole
  log is dominated by `JSON.parse` plus zod validation, which both stores pay
  identically; rows add per-row overhead that cancels the file read they save.
  The plan's "a real table gives indexed `loadRange`" does not show up either —
  `FileEventStore.loadRange` already reads only the tail of the file, so both
  answer a poller in 0–4 ms at every size.
- **Replay dominates everything past ~20 000 events.** The reducer copies
  `conversationHistory` whole on every `inference_completed`, which is quadratic
  in log length; the `agents` Map and `state` spread are constant factors, not
  scaling terms. Which store fed it stops mattering. 30 s lands at roughly
  350 000 events for either. A turn costs ~6 events, so this is orders of
  magnitude beyond any realistic session.

So SqliteEventStore is the right store for an isolate — it makes the write path
cheap and flat, which is what an event-sourced session actually does all day —
but it does not make session load faster, and nobody should expect it to.

## Limits (`/limits`)

Where standalone roj stops inside a Worker. `/limits/<name>` runs one probe from
`src/limits/`, each on its own DO so a probe that OOMs or fills storage cannot
poison the next. Every probe takes query parameters; `/limits` lists the roster.

**Read the local/production column before quoting any number.** `wrangler dev`
enforces almost nothing: workerd's OSS `LimitEnforcer` is a no-op, so CPU and
subrequest budgets never bite, and the memory ceiling you can reach locally is
V8's, not Cloudflare's.

| Ceiling | Measured | Real, or local only? |
|---|---|---|
| Script size | 7.2 MB raw / **1.57 MB gzip** | Real — under the 10 MB paid *and* 3 MB free limits |
| Startup CPU | **~103 ms** of 400 ms | Real limit, local CPU — a magnitude, not headroom |
| Event payload (DO SQLite value) | **2 199 994 B** | Real — same workerd binary |
| `read_file` result | 10 MiB | roj's own guard, not the platform's |
| WebSocket frame | **32 MiB** over a real hop | Real. An in-isolate `WebSocketPair` has no limit — a loopback artefact |
| Workspace file | 384 MiB round-tripped | Local only — production is bounded by isolate memory |
| Isolate memory | ~1.41 GB (V8 heap) | Local only — production is 128 MB, ~11× lower |

### Per turn

One turn is one user message: 2 inferences, N tool executions, **9 events**
(~3.1 KB). It costs **~10 ms of CPU and 2 subrequests**, plus one subrequest per
`runtime.exec`.

Turn cost does not grow with session age — 60 turns give a slope of +0.03
ms/turn — nor with tool-result size (512 B / 64 KB / 512 KB → 9 / 14 / 13 ms).
The reducer's whole-history copy that dominates `/bench` needs 10⁴ events to
bite, and a turn adds nine. What does scale: +1.1 ms per tool call, +35 ms of DO
wall per child agent, +5–6 ms per warm shell exec.

**Subrequests bind ~5× before CPU.** An await-until-idle request tops out around
**500 turns** (166 with four execs per turn) against CPU's ~2 800.

**Wall time is not CPU.** The SDK's default `debounceMs: 500` turns ~9 ms of work
into 1009 ms of wall; two debounce hops are 99% of a turn. Each scheduling hop
costs `max(debounce, ~12 ms) + ~2 ms`, the floor being the DO's storage commit.

### Concurrency

Parallel agents overlap **for work that awaits** — 20 agents cost 1.46× one, with
20 inferences counted open simultaneously inside the provider. For work that
computes, peak concurrency is 1 and wall time is linear. Real inference is
network-bound, so fanning out on one DO does buy speedup; prompt building,
replay, tool bodies and zod do not.

A DO took 448 live sessions with no measurable degradation and 128 concurrent
shell execs with no queueing. `Session.spawnAgentManually` caps children at **20
per parent**, hard-coded — the comment above it says "default: 20", but nothing
reads a config.

**Writes starve every timer in the isolate.** Both `SqliteEventStore` and
computer's filesystem go through synchronous `sql.exec` (computer uses
`transactionSync` throughout and rejects async transactions), so a loop of
`await store.append(...)` resolves on the microtask queue and never yields. A
400 ms burst of appends delivered **one** timer tick, 422 ms late — stalling
every other agent's debounce for the length of the burst.

### The agent loop escapes its invocation

Measured three times: a request that enqueues a message and returns leaves at
+0–2 ms with one event, and 17–45 further events, 2–6 inferences and 2 agent
spawns land afterwards with nothing in flight.

That is deliberate runtime behaviour, not a dev-server artefact. In an actor
every `setTimeout` registers a wait-until task so `IncomingRequest::drain()`
waits for it (`io-context.c++:828`), and actor background work is cancelled only
at actor shutdown, never on a per-request timeout (`io-context.c++:540`) — the
asymmetry against stateless Workers, which get a 30 s drain.

The catch is CPU accounting. An actor's budget is owned by its `IoContext` and
refilled by `topUpActor()`, which only runs when a new event is *delivered*
(`io-context.c++:271`). A timer callback never tops up, and an interval stops
rescheduling once the budget is spent (`io-context.c++:793`) — silently. So an
agent working autonomously with no incoming events draws down a budget nothing
refills. A DO alarm *is* a delivered event (`worker-entrypoint.c++:670`), which
is the second reason for the scheduler port — now wired here, see below.

**So don't drive long sessions through an await-until-idle fetch.** Send and
return, let the scheduler run the loop, subscribe or poll for state.

### A turn across an alarm

`Platform.scheduler` replaced the loop's bare `setTimeout`, and this DO
implements it over its own storage: `createAlarmScheduler(ctx)` in
`@roj-ai/computer-platform`, drained by `RojAgentDO.alarm()` into
`SessionManager.dispatchWake`. Wakes live as `roj:wake:<key>` rows in the DO's
synchronous KV, and the single alarm slot always holds the earliest of them.

`/limits/scheduler?phase=run` sends a message and then throws the booted SDK
away — SessionManager, sessions, agents, timers, all of it — before returning.
What is left is one row and one alarm. From a real run:

| | at return | after |
|---|---:|---:|
| events | 3 | 25 |
| pending wakes | 1 | 0 |
| alarm slot | `+507 ms` | none |
| alarms drained / wakes delivered | 0 / 0 | 3 / 4 |

The file the writer agent was asked for appeared at **+1 074 ms**, with no
request in flight and nothing of the session in memory: each alarm reloaded it
from its event log. `?phase=start` then `?phase=check` shows the same across two
separate requests. Three alarms carried a turn whose two debounce hops belong to
different agents — the second drain delivered `writer_1` and `orchestrator_1`
together, which is what the one-slot-many-keys reconcile is for.

Three things that took work, all reproducible from the probe:

- **Nothing awaits arming.** `scheduleProcessing()` is synchronous, so
  `wake()`/`cancel()` are called and dropped. The row and the in-memory map move
  synchronously, where the SDK's cancel-then-arm pair cannot reorder; only the
  alarm write is async, it is serialized, and it re-reads the map when it runs
  rather than trusting the arguments that queued it. `DurableObjectState.waitUntil`
  keeps it alive past the frame that issued it.
- **`shutdown()` cancels wakes.** `SessionManager.shutdown()` walks every agent
  and cancels both its keys, which is right for a session being torn down and
  fatal for an isolate merely going away. `scheduler.suspend(fn)` is how the host
  says which it is doing. The control run `?keepWakes=0` is the proof: pending
  wakes 0, alarm slot empty, 3 events, no file, ever.
- **A wake outlives the runtime.** Kill `wrangler dev` with a wake armed and the
  row is still in `_cf_KV` and the alarm still in `_cf_METADATA`; the next
  process hydrates the map from the rows and re-arms the slot from them.

The cost is small: alarm delivery landed 1–16 ms after the scheduled time, and
the two-agent smoke run takes the same ~1.6 s it did on timers. A request in
flight does not keep its own alarm out either — `?phase=spin&pollMs=1` polls as
tightly as anything here does and still takes the delivery.

One consequence for the other probes. The alarm dispatches into the one
SessionManager the DO booted, so a probe that builds a manager of its own —
`turn-cost`, `concurrency`, `memory`, and `/bench` — would strand its agents on
wakes nobody delivers. Those managers live only for their request, which is the
case `LiveScheduler` exists for, so they take a timer scheduler through
`withOwnScheduler()`.

### Two ways a session breaks that are worth guarding

**An oversized event hangs the agent.** Past the 2.2 MB SQLite value limit the
log stops at `tool_started` with no terminal event, no error event and no state
change; the agent never goes idle, and replay carries a `tool_use` with no
`tool_result`. Stock config never gets there — `read_file`'s own guard fires 25×
earlier and fails cleanly with `recoverable: true` — but raising `maxTokens`, or
any plugin putting an unbounded blob in an event, walks into it.

**A DO degrades by lifetime, not by load.** Closing a session leaves its
`/workspace/<sessionId>` directory and its event rows behind; one probe finished
with 6 238 entries under `/workspace`. `createSession` goes from ~15 ms to
~110 ms on a DO that has churned a few thousand sessions. A multi-session DO
needs a reaper.

Both probes saw creation degrade, and they disagree about why: the concurrency
probe pins it on lifetime debris (32 live sessions on an aged DO were slower than
448 on a fresh one), the memory probe on the per-session `git-status` interval
(13 → 174 ms between 100 and 1000 live). Neither isolated the variable. Open.

### Three SDK defects the probes turned up

- **`SessionManager.shutdown()` never runs `onSessionClose` hooks** — it calls
  `Session.shutdown()`, which only stops agents. `git-status` intervals outlive
  it and keep the session object reachable: a timer *and* a memory leak per
  session ever loaded.
- **`EventAppendError` reports no reason.** The cause lives only in `cause`, and
  all three logger serialisers take `{name, message, stack}`. An operator sees
  "Failed to append event to session: X".
- **`SessionFileStore.read` collapses every failure into `File not found`** —
  `catch {}` with the error discarded, so a size or memory error reads as a
  missing file.

### What only a deploy can settle

- **CPU under real streaming inference.** No API key here, so the provider is
  mocked and SSE parsing, response assembly and the per-inference call-log writes
  are all excluded.
- **Which budget the timer-driven work is charged to in production.** The OSS
  enforcer is a no-op and the real one is closed-source; this decides whether
  send-and-return genuinely escapes the ceiling or only hides it.
- **The 128 MB isolate ceiling.** Locally only V8's ~1.41 GB heap is reachable,
  and it aborts the whole workerd process rather than evicting one isolate.
  What transfers is the ratio: history costs ~2.1× its stored payload.
- **Whether Dynamic Workers get cores independent of the calling DO.**
- **Whether an alarm really refills the budget the loop spends.** The scheduler
  port is built on `topUpActor()` running for delivered events; with the local
  enforcer a no-op, that reading comes from the workerd source, not a
  measurement.
- **What an aborted isolate does to an arm in flight.** Nothing here can abort
  one, so the synchronous KV row, the `waitUntil` tracking and the boot-time
  re-arm are all designed against the failure rather than tested against it.

One incidental finding worth carrying: **`await ctx.storage.put()` is not durable
against an abort.** The write lands at the next I/O checkpoint, which an aborted
isolate never reaches. A `await scheduler.wait(0)` after the put fixes it.
