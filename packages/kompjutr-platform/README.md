# @roj-ai/kompjutr-platform

Run the Roj SDK against a [Kompjutr](https://www.npmjs.com/package/@kompjutr/do)
workspace. This adapter uses `@kompjutr/do` **0.1.2** from npm.

```bash
bun add @roj-ai/sdk @roj-ai/kompjutr-platform @kompjutr/do@0.1.2
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

- Filesystem operations and revision tracking use the workspace's SQLite data.
- Git status and shell Git commands require `git: createGit()` on the workspace.
- The shell interprets supported commands in the virtual filesystem. It is not
  a native process runner. Process spawning and native dev servers are unsupported;
  hosts can supply a service executor through SDK bootstrap overrides.
- `shellConfinement` defaults to `none`. Set it to `host` only when the host
  isolates the entire workspace. It does not create a per-directory sandbox.
  Shell path grants are unsupported.
- Session logs, LLM call logs and events are stored as SQL rows. Pass the
  `KompjutrEventStore` explicitly to bootstrap to use SQL event persistence.
- The host owns authentication, workspace isolation and storage lifetime.

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
