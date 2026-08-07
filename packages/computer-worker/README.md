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
```

A `RojAgentDO` Durable Object owns one `Workspace`. `createComputerPlatform`
turns the workspace's `SQLiteWorkspaceProvider` into a roj `Platform`, which
goes into the SDK's normal composition root (`bootstrap` →
`createSystemFromServices`) under the `isolate` plugin profile. A scripted LLM
makes the orchestrator spawn a `writer` agent, which writes a file via the
filesystem plugin. The response reports timings, the event count, and the
resulting workspace tree.

Four things the DO wires that the SDK's own defaults do not:

- **`{ pluginProfile: 'isolate' }`** — drops `services`, `resources` and
  `uploads`, the three built-ins that need a process table.
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
  so real inference has not been run in an isolate.

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
