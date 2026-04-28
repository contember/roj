# Roj Agent Server

Bun-based agent server: LLM sessions, plugin architecture, event sourcing.

**Not linted by Biome** (excluded in root biome.json). Uses its own conventions.

## Commands

```bash
bun run dev            # Watch mode with example config
bun run start          # Production start
bun run build          # Bundle to dist/ (bun build, single file)
bun run type-check     # tsc --noEmit
bun test               # Bun native test runner
```

## Architecture

- **Event sourcing:** All state mutations emit domain events; state reconstructed by replaying events through plugin reducers
- **Plugin-driven:** Nearly all business logic lives in plugins; core provides composition and lifecycle
- **Session-scoped:** Each session has isolated EventStore, agents, and plugin state

## Structure

```
src/
  main.ts              # CLI entry (bun src/main.ts <config-path>)
  server.ts            # startServer() high-level API
  bootstrap.ts         # Composition root — wires all services
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
  plugins/             # 15+ built-in plugins (mailbox, filesystem, shell, etc.)
  transport/
    http/              # Hono routes: /rpc, /health, uploads, files
    adapter/           # ServerAdapter (standalone) / ClientAdapter (worker mode)
    rpc/               # RPC protocol types
  testing/             # TestHarness, NotificationCollector
```

## Plugin System

Plugins use a fluent builder DSL:

```typescript
definePlugin('name')
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
2. **User config** (`roj.config.ts`): `defineConfig({ presets, sandboxed, snapshotter })`
3. **Plugin config**: per-preset (`pluginConfig`) and per-agent (`agentConfig`) overrides
