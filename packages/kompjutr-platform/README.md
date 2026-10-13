# @roj-ai/kompjutr-platform

Run the Roj SDK against a [Kompjutr](https://www.npmjs.com/package/@kompjutr/do)
workspace. This adapter uses `@kompjutr/do` **0.1.3** from npm.

```bash
bun add @roj-ai/sdk @roj-ai/kompjutr-platform @kompjutr/do@0.1.3
```

## Connect a workspace

The host creates a `Workspace` with SQL storage and optional Git support, then
passes the platform and event store to the SDK:

```ts
import { Workspace, createGit } from '@kompjutr/do'
import { bootstrap } from '@roj-ai/sdk'
import { createKompjutrPlatform, KompjutrEventStore } from '@roj-ai/kompjutr-platform'

const workspace = new Workspace({
	storage, // Durable Object storage supplied by the host
	git: createGit(),
	defaultGitIdentity: { name: 'Agent', email: 'agent@example.com' },
})
workspace.filesystem.mkdir('/data', { recursive: true })
workspace.filesystem.mkdir('/workspace', { recursive: true })

const platform = createKompjutrPlatform(workspace, { scheduler })
const eventStore = new KompjutrEventStore(workspace.db)
const services = bootstrap(config, { presets }, platform, {
	eventStore,
	pluginProfile: 'isolate',
})
```

`config`, `presets`, `storage` and `scheduler` come from the host application.
Use virtual paths such as `/data` and `/workspace` in the configuration and
presets. In Durable Objects, supply an alarm-backed scheduler if work must
resume after eviction; the default scheduler uses in-memory timers.

## Capabilities and boundaries

- Filesystem operations use the workspace's SQLite data. The optional `fsRevision`
  port is omitted because upstream revisions do not cover Git-only changes.
- Git status and shell Git commands require `git: createGit()` on the workspace.
- The shell interprets supported commands in the virtual filesystem. It is not
  a native process runner. Process spawning and native dev servers are unsupported;
  hosts can supply a service executor through SDK bootstrap overrides.
- `shellConfinement` defaults to `none`. Set it to `host` only when the host
  isolates the entire workspace. Set it to `paths` when one workspace holds
  several sessions' files; see [Path confinement](#path-confinement).
- Session logs, LLM call logs and events are stored as SQL rows. Pass the
  `KompjutrEventStore` explicitly to bootstrap to use SQL event persistence.
- The host owns authentication, workspace isolation and storage lifetime.

## Path confinement

With `shellConfinement: 'paths'`, every shell run sees only the grants the SDK
sends for it. Presets keep the virtual `/home/user/session` and
`/home/user/workspace` paths of `sandboxed: true`; each grant maps a virtual
directory onto a real workspace directory.

- The shell runs over a `createMountedFilesystem` view built per run. Paths
  outside every grant do not exist (`ENOENT`), and `ro` grants reject writes.
- The view fails closed on symlinks: an absolute target, a target above its
  source, or a target in another mount reads as absent. A kernel bind mount
  would follow it.
- Grant sources resolve to their real directory first. Grant paths must not
  nest, and every source must be an existing directory, or the run is rejected.
- A run without grants is unconfined, as on the Bun platform.
- Git keeps the real filesystem, so checkouts and dirty tracking stay real-path
  based. The `git` command translates the cwd and absolute path operands to
  real paths and prints real paths back as virtual ones (`rev-parse
  --show-toplevel`, `init`, `clone` and error messages). It refuses absolute path operands
  outside the grants, `init` and `clone` targets outside a writable grant, and a
  repository whose root no writable grant shows.
- Git needs no `.git` or `.gitconfig` grants: its data lives in SQL tables, not
  in a `.git` directory. Do not place a checkout at `/` or above a session's
  directories.
- Confinement covers files, not Git data. Checkouts of one store still share
  refs, objects and config across sessions.

## LLM call storage

`KompjutrLLMCallLog` stores the exact request, response, metrics and error
strings in fixed **256 KiB byte blocks**. Agent IDs, model names and provider
request IDs use the same storage, so large scalar values cannot inflate the
parent row. Each field has explicit presence, byte-length and block-count
metadata; blocks have a field name and sequence number. Strings are JSON-string
encoded before UTF-8 encoding to preserve Unicode, including lone surrogates.
Reads assemble and decode blocks in JavaScript, without SQL concatenation.
Missing blocks, invalid metadata and malformed encodings fail visibly.

The parent keeps only session/call identity keys, timestamps, status and a
format version. With the SDK's bounded identity keys (UUIDv7 call IDs), parent,
metadata and block rows stay well below the documented
[2 MB SQLite row/string/BLOB limit](https://developers.cloudflare.com/durable-objects/platform/limits/).
Local tests measure actual stored values and returned SQL rows
against a conservative 2,000,000-byte budget; they do not prove Cloudflare's
exact engine limit.

Create, complete, retention and delete run in synchronous SQL transactions.
Deleting a parent also deletes its field metadata and blocks. Completion of a
reaped call is a no-op. Normal completion replaces only outcome fields and
does not read or rewrite request blocks. Retention defaults to the newest
200 calls per session; `maxCallsPerSession: 0` retains every call.

`maxBlobBytes` defaults to `undefined`, so the SDK caller does not clamp the
request. An explicit positive value opts into the existing caller-side request
clamp, measured in UTF-8 bytes. Zero or a negative value disables it. This option
does not set the block size, limit other fields, or truncate direct store writes.
The adapter preserves the strings it receives and propagates database failures.

Existing inline rows remain readable. Their first completion migrates the
request and scalar fields transactionally; this one-time migration can read the
legacy request. An explicit format marker distinguishes inline and block rows,
including empty strings. **Older adapters cannot read the new block format.**

## Local tests

The Bun-only `@roj-ai/kompjutr-platform/testing` export provides
`BunSqliteStorage`, a local storage adapter that enforces the Durable Object
100-bind-parameter limit:

```ts
import { BunSqliteStorage } from '@roj-ai/kompjutr-platform/testing'

const storage = new BunSqliteStorage(':memory:')
// Pass storage to Workspace, then close it when the host shuts down.
storage.close()
```

Run the adapter tests from the repository root:

```bash
bun test packages/kompjutr-platform/src
bunx tsc -p packages/kompjutr-platform/tsconfig.test.json --noEmit
```
