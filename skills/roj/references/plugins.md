---
name: Custom plugin authoring
description: definePlugin DSL — config slots, state, methods, tools, hooks, dequeue, dependencies. Read when writing a new plugin.
---

# Custom plugin authoring

## Builder DSL

```ts
const plugin = definePlugin('myPlugin')
  .pluginConfig<MyPresetConfig>()
  .agentConfig<MyAgentConfig>()
  .events([myEvents])
  .state({ key: 'mine', initial: () => ({...}), reduce: (s, e) => s })
  .dependencies([sessionStatePlugin])
  .context(async (ctx, cfg) => ({ executor: makeExecutor(cfg) }))
  .method('do', { input, output, handler })
  .managerMethod('all', { input, output, handler })
  .notification('progress', { schema })
  .tool('mytool', { description, input, execute })
  .tools((ctx) => [/* dynamic */])
  .hook('beforeInference', handler)
  .sessionHook('onSessionReady', handler)
  .dequeue({ hasPendingMessages, getPendingMessages, markConsumed })
  .systemPrompt((ctx) => 'fragment or null')
  .status((ctx) => 'agent status label or null')
  .isSessionEnabled(({ pluginConfig }) => Boolean(pluginConfig.enabled))
  .isEnabled(({ pluginAgentConfig }) => pluginAgentConfig?.enabled !== false)
  .build()
```

Notes on the less-obvious pieces:

- `.state({ reduce })` signature: `reduce(state, event, sessionState, pluginConfig)`.
- `.context(fn)` is for long-lived per-session resources (executors, clients). Result available as `ctx.pluginContext`.
- `.managerMethod(name, def)` runs without a session — for listings, cross-session admin. Context lacks `sessionId`/`agentId`; gets `sessionManager`/`presets`/`platform` instead.
- `.dependencies([plugin])` exposes their methods via `ctx.deps.<name>`. Order matters at registration.
- `.isSessionEnabled` gates the whole plugin per-session; `.isEnabled` gates tools per-agent (state and hooks still apply unless session-gated).
- `.build()` is required, always last.

## Lifecycle hooks

Per-agent flow per turn:

```
onStart → beforeInference → [LLM] → afterInference → beforeToolCall → [tool] → afterToolCall
                                                                         ↓
                                                  loop to beforeInference if more tool calls
                                                                         ↓
                                                                onComplete | onError
```

Each hook returns `null` (continue) or an action:

| Hook | Action shapes |
|---|---|
| `onStart` | `{ action: 'pause', reason? }` |
| `beforeInference` | `{ action: 'skip', response }` \| `{ action: 'pause' }` |
| `afterInference` | `{ action: 'modify', response }` \| `{ action: 'retry' }` \| `{ action: 'pause' }` |
| `beforeToolCall` | `{ action: 'block', reason }` \| `{ action: 'replace', toolCall }` \| `{ action: 'pause' }` |
| `afterToolCall` | `{ action: 'modify', result }` \| `{ action: 'pause' }` |
| `onComplete` / `onError` | `{ action: 'pause' }` |

Hook context extends plugin context with `agentId`, `agentState`, `agentConfig`, and hook-specific fields (`pendingMessages`, `response`, `toolCall`, `result`, `error`).

Session hooks: `onSessionReady` (once, after init + deps), `onSessionClose` (once on termination).

---

## Context shape

Every handler receives a context with:

```ts
type Ctx = {
  // session
  sessionId: SessionId
  sessionState: SessionState              // readonly composed state
  environment: SessionEnvironment         // { sessionDir, workspaceDir?, sandboxed, dataDir }
  files: FileStore                        // session-scoped fs
  llm: LLMProvider
  eventStore: EventStore
  llmLogger?: LLMLogger
  platform: Platform                      // fs/process/env adapters
  logger: Logger
  emitEvent: (event) => Promise<void>
  notify: (type, payload) => void

  // plugin
  pluginConfig: TConfig                   // from .pluginConfig<T>()
  pluginAgentConfig?: TAgentConfig        // from .agentConfig<T>()
  pluginContext: TContext                 // from .context(fn)
  pluginState: TState                     // from .state({...})
  self: { [methodName]: (input) => Promise<Result> }
  deps: { [pluginName]: { [methodName]: (input) => Promise<Result> } }
  schedule: () => void                    // schedule current agent's next turn
  scheduleAgent: (id) => void             // session hooks only

  // agent (only in agent-level hooks/tools)
  agentId: AgentId
  agentState: AgentState
  agentConfig: AgentConfig
  parentId: AgentId | null

  // method handlers
  caller: { source: 'agent' | 'client' | 'system'; meta: object }
}
```

**Read paths from `environment`, not from a hardcoded constant.** In sandboxed mode the agent sees virtual paths — but `environment.sessionDir` and `environment.workspaceDir` are *real*. See `paths-and-sandbox.md`.

---

## Tools

```ts
.tool('analyze_text', {
  description: 'Score a piece of text for clarity (0-100)',
  input: z.object({ text: z.string().min(1) }),
  execute: async (input, toolCtx, pluginCtx) => {
    if (input.text.length > 10_000) {
      return Err({ message: 'too long', recoverable: false })
    }
    const score = await pluginCtx.pluginContext.scorer.run(input.text)
    return Ok(JSON.stringify({ score }))
  },
})
```

`recoverable: true` ⇒ retryable (network blip, rate limit); `false` ⇒ permanent. Return `Ok(string)` (typically JSON). Dynamic list: `.tools((ctx) => ctx.pluginAgentConfig?.enabled === false ? [] : [...])`.

## Methods (RPC)

```ts
.method('export', {
  input: z.object({ sessionId: z.string() }),
  output: z.object({ path: z.string() }),
  handler: async (ctx) => Ok({ path: await doWork(ctx) }),
})
```

Callable from: other plugins via `ctx.deps.thisPlugin.export(...)` (with `.dependencies`), same plugin via `ctx.self.export(...)`, or transport: `POST /api/v1/instances/{id}/sessions/{sid}/rpc` with `{ method: 'pluginName.export', input }`.

## Notifications

Ephemeral broadcasts (not persisted, not replayed). For state the SPA must reconstruct, emit a domain event with `emitEvent` instead.

```ts
.notification('progress', { schema: z.object({ percent: z.number(), label: z.string() }) })

ctx.notify('progress', { percent: 42, label: 'extracting' })
```

SPA reads via `useChat` / `useSessionStore`. Good for liveness UI (progress, toasts) where a missed message is not a correctness problem.

## Dequeue (message injection)

Inject synthetic user messages before each inference. `uploadsPlugin` uses this for attachments; `mailboxPlugin` for inter-agent messages.

```ts
.dequeue({
  hasPendingMessages: (ctx) => ctx.pluginState.pending.length > 0,

  getPendingMessages: (ctx) => {
    if (ctx.pluginState.pending.length === 0) return null
    return {
      messages: [{ role: 'user', content: formatMessages(ctx.pluginState.pending) }],
      token: ctx.pluginState.pending.map(m => m.id),  // opaque, returned to markConsumed
    }
  },

  markConsumed: async (ctx, token) => {
    await ctx.emitEvent(myEvents.create('messages_consumed', { ids: token }))
  },
})
```

`token` is opaque to the framework. After the inference consumes the messages, `markConsumed(ctx, token)` is called with whatever you returned, so you know exactly what was delivered.

---

## Wiring into a preset

```ts
createPreset({
  id: 'demo',
  name: 'Demo',
  plugins: [myPlugin.configure({ apiKey: process.env.MY_KEY! })],
  orchestrator: createOrchestrator({
    name: 'main',
    plugins: [myPlugin.configureAgent({ enabled: true })],
  }),
})
```

`.configure()` writes the session-level `pluginConfig` (at most once per preset). `.configureAgent()` writes the per-agent slice. Prefer `pluginName.configureAgent({ enabled: false })` over implementing your own `isEnabled` check.

---

## Skeleton

```ts
import { definePlugin, Err, Ok, z, type DomainEvent } from '@roj-ai/sdk'

const myEvents = {
  create: <K extends 'item_added' | 'item_removed'>(
    type: K,
    payload: K extends 'item_added' ? { id: string; value: string } : { id: string },
  ) => ({ type, payload, timestamp: Date.now() } as const),
}

interface MyConfig { apiUrl?: string }
interface MyAgentConfig { enabled?: boolean }
interface MyState { items: Array<{ id: string; value: string }> }

export const myPlugin = definePlugin('my')
  .pluginConfig<MyConfig>()
  .agentConfig<MyAgentConfig>()
  .events([myEvents])
  .state<MyState>({
    key: 'my',
    initial: () => ({ items: [] }),
    reduce: (state, event) => {
      switch (event.type) {
        case 'item_added':
          return { items: [...state.items, event.payload] }
        case 'item_removed':
          return { items: state.items.filter(i => i.id !== event.payload.id) }
        default:
          return state
      }
    },
  })
  .context(async (ctx, cfg) => ({
    api: { fetch: (path: string) => fetch(`${cfg.apiUrl ?? '/'}${path}`) },
  }))
  .tool('add_item', {
    description: 'Append an item',
    input: z.object({ value: z.string().min(1) }),
    execute: async (input, _toolCtx, ctx) => {
      const id = crypto.randomUUID()
      await ctx.emitEvent(myEvents.create('item_added', { id, value: input.value }))
      return Ok(JSON.stringify({ id }))
    },
  })
  .method('list', {
    input: z.object({ sessionId: z.string() }),
    output: z.object({ items: z.array(z.object({ id: z.string(), value: z.string() })) }),
    handler: async (ctx) => Ok({ items: ctx.pluginState.items }),
  })
  .hook('beforeInference', async (ctx) => {
    if (ctx.pluginState.items.length > 100) {
      return { action: 'pause', reason: 'too many items' }
    }
    return null
  })
  .build()
```
