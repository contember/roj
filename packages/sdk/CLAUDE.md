# Roj Agent Server

Bun-based agent server: LLM sessions, plugin architecture, event sourcing.

## Commands

Run from the repo root — this package declares only `type-check`.

```bash
bun run ts:build       # Build all packages (tsc --build + tsc-alias)
bun run lint           # Biome (this package IS linted — 262 files)
bun test packages/sdk/src
```

## Architecture

- **Event sourcing:** All state mutations emit domain events; state reconstructed by replaying events through plugin reducers
- **Plugin-driven:** Nearly all business logic lives in plugins; core provides composition and lifecycle
- **Session-scoped:** Each session has isolated EventStore, agents, and plugin state

## Structure

```
src/
  index.ts             # Public API surface
  bootstrap.ts         # Composition root — wires all services
  builtin-events.ts    # Event definitions shared across core
  config.ts            # Config interface, loadConfig (env vars)
  user-config.ts       # defineConfig for roj.config.ts files
  core/
    plugins/           # Plugin builder DSL (definePlugin)
    sessions/          # Session lifecycle, state, manager
    agents/            # Agent state, schema, roles, execution
    llm/               # LLM providers (Anthropic, OpenRouter, mock)
    tools/             # Tool definitions, executor
    preset/            # defineAgent, createPreset, createOrchestrator
    events/            # EventStore (file/memory), types
    file-store/        # SessionFileStore — agent-visible path resolution
    image/             # Image processing and resizing
  plugins/             # 22 built-in plugins (mailbox, filesystem, shell, services, etc.)
  transport/
    http/              # Hono routes: /rpc, /health, uploads, files
    adapter/           # ServerAdapter (standalone) / ClientAdapter (worker mode)
    rpc/               # RPC protocol types
  testing/             # TestHarness, NotificationCollector (published as ./testing)
  lib/                 # Logger, Result, small utilities
  platform/            # Platform interfaces (fs, process)
  bun-platform/        # Bun implementations (published as ./bun-platform)
```

## Plugin System

Plugins use a fluent builder DSL:

```typescript
definePlugin('name')
  .order(100)                 // Hook precedence; lower first, default DEFAULT_PLUGIN_ORDER
  .pluginConfig<T>()          // Session-wide config
  .agentConfig<T>()           // Per-agent config
  .events([eventDefs])        // Domain events (Zod-typed)
  .state<T>({ key, initial, reduce })  // State slice with reducer
  .method('name', { input, output, handler })  // RPC method
  .tools((ctx) => [...])      // Agent tools
  .hook('beforeInference', handler)  // Lifecycle hook
  .build()
```

Lifecycle hooks: `onStart`, `beforeInference`, `afterInference`, `beforeToolCall`, `afterToolCall`, `onComplete`, `onError`, `dequeue`.

## Transport

- `POST /rpc` — all plugin methods routed here (single or batch: `{ batch: [...] }`)
- WebSocket for ephemeral notifications only (not persisted)
- Two modes: standalone (ServerAdapter) or worker-connected (ClientAdapter via WS to Durable Object)

## Testing

Use `TestHarness` with mock LLM:

```typescript
const harness = new TestHarness({
  presets: [preset],
  mockHandler: (messages) => ({ content: '...', toolCalls: [], finishReason: 'stop', metrics: {...} })
})
const session = await harness.createSession('preset-id')
await session.waitForAllAgentsIdle()
await harness.shutdown()
```

## Config Levels

1. **System config** (`config.ts`): env vars — port, API keys, persistence mode, log format
2. **User config** (`roj.config.ts`): `defineConfig({ presets, sandboxed, extraBinds, snapshotter })` — `sandboxed` and `extraBinds` fold into every preset
3. **Plugin config**: per-preset (`pluginConfig`) and per-agent (`agentConfig`) overrides
