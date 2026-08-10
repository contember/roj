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
                                # ?rounds=N also times the git-status revision gate (0 skips it)
curl localhost:8787/reap        # reclaim closed sessions; ?events=1 drops their logs too
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
  `platform.git` and through `git-status.refresh`, whose answer and whose
  notification must agree.
- A `git-status` pull that the filesystem revision gates costs ~0.07 ms against
  ~9 ms for one that recomputes — `/git?rounds=N` times both. `revisionBefore`
  and `revisionAfter` bracket the gated phase and must be equal: they are the
  proof that the git read itself writes nothing back into the workspace.
- **Nothing roj owns is armed once a session settles** — no timer, no wake, no
  alarm. `/limits/idle` counts all three; see "An idle DO" below.

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

### What a turn writes to the filesystem (`/limits/fs-traffic`)

`SqliteEventStore` took the event log off the filesystem. What was left was one
file, and it was not the agent's. `/limits/fs-traffic` *is* the `FileSystem` the
SDK boots on — it wraps `platform.fs` before `boot()`, so every call the
composition root hands out is counted with its path and its bytes.

One two-agent smoke turn (4 inferences, 25 events) used to make **32
`platform.fs` calls, 24 of them writes, 4 453 B**. Identical across four runs:

| path | op | count | bytes |
|---|---|---:|---:|
| `/data/sessions/<id>/session.log` | `appendFile` | **23** | **4 377** |
| `/workspace/<id>/note.md` | `writeFile` | 1 | 76 |
| both trees | `readdir` / `stat` / `mkdir` | 8 | 0 |

`createSession` adds two `mkdir` and nothing else. **The agent's actual work
product is one write of 76 B; the other 23 were the session log.**

The log now goes to rows instead — `platform.sessionLog`, an optional port whose
absence is the old behaviour, backed here by `SqliteSessionLog`. The same turn
makes **7 `platform.fs` calls, 1 of them a write, 76 B**: the agent's note and
nothing else. The 23 lines and their 4 377 B are unchanged, and
`turn.sessionLog.store` in the probe's report is where they went. A host with
real files is untouched: same file, same bytes, same byte-offset cursor.

Per-operation cost — 600 operations per figure, bracketed by scheduler yields,
never one call timed alone:

| operation | ms/op |
|---|---:|
| `appendFile`, 190 B line, onto 0 B / 64 KiB / 1 MiB | 0.90 / 1.21 / 0.62 |
| `writeFile`, whole file, 4 KiB / 64 KiB | 0.50 / 0.53 |
| one bound `INSERT`, clustered `(session_id, seq)` `WITHOUT ROWID` | **0.053** |

The append is flat in file size — chunk-local, as `/limits/payload` found — and
costs ~2 VFS operations, because the adapter emulates it as `lstat` +
`writeRangeSync` at the current end. Against a row it is **12–27×**. Absolute
figures move ±30% between runs on a contended box; the ratio does not, and the
`INSERT` held at 0.05–0.065 ms across five runs.

So the session log cost **~19–21 ms of CPU per turn** where the same 23 lines as
rows cost ~1.4 ms. Against the loop it records: this turn runs 4 inferences, so
that was ~5 ms of log per inference, while `/limits/turn-cost` on the same box
does 8–12 ms of `workMs` across 2 inferences — 4–6 ms each. **The session log
cost about what the agent loop it is logging costs.**

Two things made that easy to miss:

- **`FileLogger` never awaits its append** — `fs.appendFile(...).catch(() => {})`.
  The work lands on the microtask queue and runs during the debounce the wall
  figure already contains, so `turn-cost`'s `workMs` cannot see it. `?ab=N` runs
  N rounds of one turn in a fresh session with the writes suppressed at the
  adapter against one with them: 1 557 ms vs 1 546 ms over 4 rounds. Half the
  projection, in the right direction — the other half hid in the debounce. CPU
  is metered in production; wall is not.
- **`config.logLevel` does not reach it, on purpose.** The session logger is
  fixed at `debug` — it is the detailed record, the console logger is the
  filtered one — so `logLevel: 'info'` still writes all 23 lines. **20 of the 23
  are `debug`**, and nine distinct messages account for every one of them —
  `Executing beforeInference handlers`, `Running inference`,
  `Executing afterToolCall handlers` and the like, ~190 B each. The point of the
  move to rows is to keep that detail and make it cheap, not to drop it.

**The LLM call log is a second file-shaped table, and this harness never writes
it**: `bootstrap` skips `LLMLogger` entirely whenever `config.llmMock` is set.
The probe sizes it instead, from the `InferenceRequest`s the SDK really built —
4 inferences per turn at 8.5–10.5 KB each (system prompt ~5 KB, tool JSON
schemas ~5 KB), **34.8 KB per turn**. `LLMLogger` writes each entry once on
`createCall` and rewrites it whole on `completeCall`, having read it back first:
**8 `writeFile` + 4 `readFile` and ~70 KB per turn**, pretty-printed so larger
still. `listCalls` paginates by listing the whole directory and sorting the
filenames, then reading the page's files one at a time — an `ORDER BY … LIMIT`
spelled out in `readdir`.

Neither log goes through `SessionFileStore`. `FileLogger` and `LLMLogger` both
hold `platform.fs` directly, which is why the census had to sit on the port
rather than on the store. Both are read only over RPC: `logs.tail` for the debug
UI's Logs page, and `llm.getCalls` / `getCall` / `getCurlCommand` for its LLM
Calls page and `@roj-ai/cli`. Nothing outside the SDK opens either.

`logs.tail`'s cursor stays a plain number and stays opaque: a byte offset where
the log is a file, a row seq where it is a table. Every reader already treats it
as a token to hand back — the debug UI stores `offset` in state, and webmaster's
worker only proxies the method by name — so no reader changed. Reclamation moved
with it: the reaper drops the rows on its **files** branch, beside
`rm -r /data/sessions/<id>`, and reports them as `removedLogLines`. The LLM call
log is still files, still reaped with the directory.

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

### An idle DO (`/limits/idle`)

A DO may only be evicted when it has nothing outstanding, and workerd counts an
armed actor timer as outstanding: each one registers a wait-until task that
`IncomingRequest::drain()` waits for (`io-context.c++:828`), and a repeating
timer arms a fresh one per tick (`io-context.c++:793`). `git-status` used to arm
a 2 s `setInterval` per live session, so one open session was enough to keep this
object awake for good.

It no longer arms one here. The plugin now decides from the host: where
`platform.scheduler` is a `LiveScheduler` — a Bun host, whose process outlives a
wake and whose workspace has writers roj never sees — the 2 s clock runs exactly
as before; where it is not, the plugin arms nothing and refreshes at the turn
boundary after a tool call, plus whenever a client calls `git-status.refresh`.

`/limits/idle` censuses all three ways this DO can be held, by wrapping the timer
globals before the SDK boots. From a real run — one two-agent turn, a 6 s quiet
window, the SDK dropped as an eviction would, then a second message that can only
be served by replaying the event log:

| checkpoint | timers armed / cleared / outstanding | pending wakes | alarm slot | events |
|---|---|---:|---:|---:|
| settled | 1 / 1 / **0** | 0 | none | 25 |
| quiet +6 000 ms | 1 / 1 / **0** | 0 | none | 25 |
| SDK evicted | 1 / 1 / **0** | 0 | none | 25 |
| settled again | 1 / 1 / **0** | 0 | none | 30 |
| after a `git-status` pull | 1 / 1 / **0** | 0 | none | 30 |

The one timer ever armed is the probe's own self-check, which exists so that a
zero means the census works rather than that it is broken. Over the whole run roj
armed **no timer at all**.

The control is what makes that readable. The same probe then builds a manager
through `withOwnScheduler()` — a `LiveScheduler`, i.e. a Bun host — and the
census immediately holds one `interval, delayMs: 2000` armed from
`Object.onSessionReady`, which `session.close()` clears. Same census, same
isolate, opposite answer.

What the poll bought is priced in the same run. The probe writes a file straight
through `platform.fs`, with no tool call and no request behind it: the snapshot
stays at `uncommittedFiles: 1` across the 6 s window and only moves to 2 when
something pulls. That is the whole behavioural cost, and it is a class of writer
that exists on a Bun host (an editor, a dev server under `services`) and not in
an isolate, where every byte arrives through a tool call or an inbound request.

**Eviction itself is unobserved.** `wrangler dev` never evicts a Durable Object,
so this is the precondition for hibernation, not hibernation. The transport
already uses hibernatable WebSockets; whether the object actually sleeps can only
be settled on a deploy.

### Two ways a session breaks that are worth guarding

**An oversized event hangs the agent.** Past the 2.2 MB SQLite value limit the
log stops at `tool_started` with no terminal event, no error event and no state
change; the agent never goes idle, and replay carries a `tool_use` with no
`tool_result`. Stock config never gets there — `read_file`'s own guard fires 25×
earlier and fails cleanly with `recoverable: true` — but raising `maxTokens`, or
any plugin putting an unbounded blob in an event, walks into it.

**A DO accumulates for its whole lifetime.** Closing a session leaves its
`/workspace/<sessionId>` directory, its `/data/sessions/<sessionId>` log
directory and its event rows behind; one probe finished with 6 238 entries under
`/workspace`. Nothing in the SDK reclaims any of it, so a long-lived object grows
without bound — 2 500 sessions of the shape `/limits/reaper` creates cost 25.8 MB
of DO SQLite and 10 000 filesystem entries. A multi-session DO needs a reaper;
`/reap` and `/limits/reaper` are both below.

### Reaping a closed session (`/reap`, `/limits/reaper`)

**Nothing reaps on close.** `session.close()` seals the log but the session can
still be `reopen()`ed, and `Session.shutdown()` runs the very same
`onSessionClose` hooks when the *isolate* goes away — so a plugin hook cannot
tell "this session is over" from "this object is being evicted", and one that
deleted data would empty every loaded session's workspace on an eviction. The
event log is also the only record the session ever ran. Reclaiming is therefore a
host call, with the host's own retention policy: `createSessionReaper` in
`@roj-ai/computer-platform`, wired in `RojAgentDO`'s constructor and reachable
only from `GET /reap` and the probe.

What it will and will not touch:

| Guard | Rule |
|---|---|
| Closed only | It reaps what `SessionMetadata.status` says is `closed`, re-read per session and again after the files go, because the listing is a snapshot and `reopen()` can land between two awaits. |
| Files by default | Only the workspace and the data directory. `?events=1` adds the rows, and `SqliteEventStore.deleteSession` is deliberately outside the `EventStore` contract so nothing in the SDK can reach it. |
| Owned directories only | A `workspaceDir` whose last segment is not the session id came from a preset that shares one directory between sessions; it is reported, never removed — and its rows stay too, or nothing would name the directory again. |
| Through the VFS | `fs.rm(dir, { recursive: true })`. `vfs_blobs` is content-addressed with no refcount, so hand-written SQL would either leak every blob or corrupt the files that share one. |
| Idempotent | A files-only reap stamps `custom.reapedAt` on the rows it leaves. Without it the session still reads as closed and every later sweep re-walks it — 10 200 removals across 50 sweeps of 400 sessions, before the stamp existed. |

`/limits/reaper` churns the same sessions six ways and reaps three of them, all
inside one request so a shared box loads every arm equally. Each arm is preceded
by a full reap, so all six start from the same clean object; `-do` arms drive the
DO's own SessionManager on the alarm scheduler, the others build their own on a
`LiveScheduler` the way every other probe does. `createSession` is the mean of
the last window against the first, inside one arm.

400 sessions per arm, 3 files and 27 events each:

| arm | close | reap | createSession first → last | growth | entries left |
|---|:--|:--|---:|---:|---:|
| `all` | yes | files + rows | 9.8 → 9.9 ms | **1.01** | 0 |
| `workspace` | yes | files | 9.7 → 9.4 ms | **0.96** | 0 |
| `off` | yes | — | 10.0 → 12.7 ms | **1.27** | 1 600 |
| `off-do` | yes | — | 4.6 → 4.3 ms | **0.94** | 1 600 |
| `hold` | no | — | 8.6 → 25.4 ms | **2.96** | 1 600 |
| `hold-do` | no | — | 7.4 → 4.6 ms | **0.61** | 1 600 |

2 500 sessions per arm, the regime the ~110 ms observation came from:

| arm | createSession first → last | growth | entries left | DO SQLite |
|---|---:|---:|---:|---:|
| `all` | 11.2 → 10.2 ms | **0.91** | 0 | 3.8 MB |
| `off` | 11.2 → 32.8 ms | **2.93** | 10 000 | 25.8 MB |
| `off-do` | 5.3 → 4.7 ms | **0.89** | 10 000 | 25.8 MB |

**Which of the two explanations the numbers support: both, and they are the same
one.** `off` degrades with a live count of 1, which rules out the interval as
such — but `off-do` holds the identical 10 000 entries and stays flat, which
rules out the debris as such. What costs is `git-status`'s `LiveScheduler` branch,
whose per-session work grows with the accumulated filesystem; the debris is what
makes it grow. `hold` at 300 live and `off` at 2 500 lifetime are the two faces
of that, which is why the concurrency probe (aged DO) and the memory probe (many
live) each saw one and neither saw the other. Both of them build their manager
through `withOwnScheduler()`, so both were measuring that branch.

Three consequences, in the order they matter:

- **This DO already avoids the latency.** Its scheduler is the alarm scheduler,
  so `git-status` takes neither branch: `off-do` and `hold-do` are flat, and
  roughly 2× cheaper in absolute terms than the same work with the plugin live.
  On this host the reaper's case is **storage**, not latency.
- **On a Bun host the reaper is the latency fix too.** `all` stays flat at 2 500
  where `off` is 2.9× worse, on the same `LiveScheduler` — reclaiming the debris
  removes the growth without touching the plugin.
- **Reaping is not free.** A sweep of 8 sessions costs ~120 ms, about 15 ms per
  session against `createSession`'s ~10 ms, nearly all of it the recursive
  removes. Sweep on a schedule with a grace period, not on every close.

Two things the probe cannot see. `sql.databaseSize` never falls — SQLite frees
pages on `DELETE` but does not shrink the file — so only the row counts and the
entry counts show a reap landing. And a bare `mkdir` under `/workspace` is flat
at ~0.4 ms whether the directory holds 4 siblings or 2 500, so whatever
`git-status` pays for is not directory creation.

One caveat on provenance: these runs were taken while `git-status` was being
changed in the same tree, so the `own`-manager arms (`all`, `workspace`, `off`,
`hold`) price whatever the plugin did at that moment. Re-run them once the
revision gate settles — the `-do` arms and the storage figures do not depend on
it.

### Three SDK defects the probes turned up

- **`SessionManager.shutdown()` never runs `onSessionClose` hooks** — it calls
  `Session.shutdown()`, which only stops agents. On a host with a live scheduler
  `git-status` intervals therefore outlive it and keep the session object
  reachable: a timer *and* a memory leak per session ever loaded. On this DO only
  the memory leak is left, since the plugin arms no timer here.
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
