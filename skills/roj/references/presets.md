---
name: Preset & agent reference
description: createPreset, defineAgent, createOrchestrator, services, resources, uploads, session state, and one-liner index of every built-in plugin
---

# Presets, agents & built-in plugins

## createPreset

```ts
createPreset({
  id: string,
  name: string,
  description?: string,
  orchestrator: OrchestratorConfig,
  communicator?: AgentConfig,
  plugins?: SessionPluginConfig[],
  workspaceDir?: string,            // supports `{sessionId}` placeholder
  sandboxed?: boolean,              // host-default unless overridden
  defaultResourceSlugs?: string[],
  llmMiddleware?: LLMMiddleware[],
})
```

- `{sessionId}` in `workspaceDir` is required for fork support.
- `sandboxed: true` makes the agent see `/home/user/session` and `/home/user/workspace` (see `paths-and-sandbox.md`).
- `agents` is auto-collected from the orchestrator/communicator tree, not declared on the preset.

## defineAgent

```ts
defineAgent({
  name: string,
  system: string,                          // supports {{sessionDir}}/{{workspaceDir}}
  model: ModelId,
  tools?: ToolDefinition[],                // own tools (plugin tools added separately)
  agents?: AgentDefinition[],
  plugins?: AgentPluginConfig[],           // .configureAgent(...) overrides
  services?: ServiceConfig[],
  input?: z.ZodType,                       // typed input for `start_<name>`
  debounceMs?: number,                     // default 500
  debounceCallback?: DebounceCallback,
  checkIntervalMs?: number,                // default 100
  userCommunication?: 'tool' | 'xml' | 'both',  // default 'tool'
  llmMiddleware?: LLMMiddleware[],
})
```

- `tools: []` is **not** "no tools" — plugin tools are contributed separately. To opt out per-agent: `pluginName.configureAgent({ enabled: false })`.
- `agents` declares spawnable sub-agents; `agentsPlugin` materialises one `start_<name>` tool per entry, typed by the sub-agent's `input` (free-text if absent).

## createOrchestrator + roles

`createOrchestrator(config)` is `defineAgent` tagged as entry. Three role slots:

| Role | What | When |
|---|---|---|
| **orchestrator** | decides flow, spawns sub-agents, calls services, asks user | always |
| **communicator** | optional user-facing gateway (smaller model for translation, tone, buffering) | `preset.communicator` set |
| **child** | sub-agent reachable from orchestrator's `agents` tree, reports via mailbox | auto |

Without a communicator, the orchestrator sees user messages directly. With one, the communicator forwards via mailbox.

---

## Services

`ServiceConfig` describes a long-running command (dev server, db, daemon) that the runtime spawns alongside the agent.

```ts
import type { ServiceConfig } from '@roj-ai/sdk'

const devService: ServiceConfig = {
  type: 'dev',                                 // unique within preset
  description: 'Development server',
  command: ({ port }) => `bunx vite --port ${port}`,
  cwd?: string,                                // default: workspace
  env?: Record<string, string>,
  autoStart?: boolean,                         // default false
  readyPattern?: string,                       // regex to detect "ready" in stdout
  gracefulStopMs?: number,                     // SIGTERM→SIGKILL window (default 5000)
  startupTimeoutMs?: number,                   // fail-fast (default 30000)
  logBufferSize?: number,                      // ring buffer (default 200)
}
```

- `command` as a function receives `{ port }` from a pool — pass it to the binary's `--port` flag.
- Wire by putting `services: [devService]` on the agent. SPA-side: `useChat({ services: ['dev'] })` + `usePreviewUrl()`.
- `autoStart: true` ⇒ up on session create. Default = on-demand (preferable for expensive services).

---

## Resources & postInject

Platform-managed file/zip blobs keyed by `slug`, extracted into workspace at start-up. Opt in via `defaultResourceSlugs: ['my-template']` on the preset, or host injects ad-hoc.

```ts
resourcesPlugin.configure({
  targetDir?: string,           // default: workspaceDir or sessionDir
  postInject?: PostInjectHook,  // postInjectRules([...]) or custom
})

postInjectRules([
  { name: 'bun install', when: 'package.json', run: ['bun', 'install'] },
  { name: 'scaffold', when: '_init/scaffold.sh', run: ['bash', '_init/scaffold.sh'] },
])
```

Rule fields: `name`, `when` (relative path that must exist), `cwd` (`'target'` default | `'session'`), `run`, `env`, `timeoutMs` (default 300000), `continueOnError` (default true). Rules run before `resource_injected`, so the agent never sees a half-set-up workspace.

`roj.resource.json` at the zip root (`ResourceManifestSchema`) can declare its own rules; the file is deleted post-extraction. CLI: `roj resource <path|dir> --slug <slug>`.

---

## Uploads

`uploadsPlugin` stores client-uploaded files at `{sessionDir}/uploads/<uploadId>/<filename>` (+ `meta.json`). Preprocessors registered by bootstrap: **markitdown** (PDF/DOCX/PPTX/HTML), **image-classifier**, **zip** (auto-extract).

On next dequeue, pending uploads become a synthetic user message:

```xml
<attachment uploadId="..." filename="brief.pdf" type="application/pdf" basePath="/home/user/session/uploads/<uploadId>">
…extracted text…
</attachment>
```

Agent reads raw bytes from `<basePath>/<filename>`. Don't list `{{sessionDir}}/uploads/` — it returns UUID dirs.

---

## Session state

Schema-validated key-value state shared between agent / client / system.

```ts
sessionStatePlugin.configure({
  schema: z.object({ exportReady: z.boolean(), step: z.string() }),
  initial: { exportReady: false, step: 'idle' },
  validate?: (current, proposed, caller) => true | 'agents may not set step',
})
```

Plugin access: declare `dependencies([sessionStatePlugin])`, then `ctx.deps.sessionState.get/update({ sessionId, ... })`. SPA: `useSessionStateValue(key, default)` + `useUpdateSessionState()`.

---

## User chat & mailbox

`userChatPlugin.UserCommunicationMode`:

| Mode | Mechanism |
|---|---|
| `'tool'` (default) | `tell_user` / `ask_user` tools |
| `'xml'` | `<user>…</user>` tags in assistant turn |
| `'both'` | both |

`mailboxPlugin` is inter-agent transport. `MailboxMessage`: `{ id, from, content, timestamp, consumed, answerTo?, answerValue?, attachments?, context? }`. `from` ∈ `AgentId | 'user' | 'orchestrator' | 'communicator' | 'debug' | 'worker'`; `context` is LLM-visible but hidden from user.

`ask_user` types: `single_choice`, `multi_choice`, `confirm`, `text`, `rating`. Multiple calls in one turn batch into one questionnaire.

---

## Workers

Long-running, pausable, state-driven background jobs (crawls, transforms, scheduled fetches). Don't block agent inference.

```ts
const crawler = createWorkerDefinition(
  'web-crawler',
  'Crawl and extract structured data',
  z.object({ url: z.url(), depth: z.number().default(1) }),
  {
    initialState: (cfg) => ({ visited: [] as string[] }),
    reduce: (state, event) => state,
    execute: async (cfg, ctx) => Ok({ ... }),
    handleCommand: async (cmd, ctx) => { ... },
    summarizeState: (state) => ({ visitedCount: state.visited.length }),
  },
)

workerPlugin.configure({ definitions: [crawler] })
```

Plugin exposes `spawn_worker`, `worker_command`, etc. `summarizeState` keeps large state out of LLM context.

---

## Built-in plugins

Two categories — **most common source of confusion**.

### Auto-registered (do NOT add to `plugins: [...]`)

Bootstrap registers these in every session. Use `.configureAgent({...})` for per-agent overrides; `.configure({...})` on the preset only for plugins with session-level config (e.g. `sessionStatePlugin`).

| Plugin | What it gives you |
|---|---|
| `sessionLifecyclePlugin` + `presetsPlugin` | Manager methods: `sessions.list/create/close`, `presets.list` |
| `mailboxPlugin` | Inter-agent transport |
| `agentsPlugin` | `start_<name>` tools from agent's `agents` array |
| `agentStatusPlugin` | Per-agent live status (idle/thinking/working) |
| `userChatPlugin` | `tell_user` / `ask_user` (or `<user>` XML) |
| `uploadsPlugin` | File uploads + `<attachment>` injection |
| `resourcesPlugin` | Platform resource injection + post-inject |
| `filesystemPlugin` (`@roj-ai/sdk/tools/filesystem`) | `read_file`, `write_file`, `edit_file`, `list_directory`, glob |
| `servicePlugin` | Picks up `services: [...]` per agent |
| `sessionStatePlugin` | Typed KV session state |
| `gitStatusPlugin` | Polls `git status`; notifies on change |
| `logsPlugin` | `logs.tail()` |
| `llmDebugPlugin` | `llm.getCalls()` |
| `sessionStatsPlugin` | Token / cost / call counters |

To opt an agent out of a plugin's tools: `.configureAgent({ enabled: false })`, or `defaultEnabled: false` at session level (where supported).

### Opt-in (must add to `plugins: [...]`)

| Plugin | Import | What it gives you |
|---|---|---|
| `shellPlugin` | `@roj-ai/sdk/tools/shell` | `run_command` with bwrap; see `paths-and-sandbox.md` |
| `skillsPlugin` | `@roj-ai/sdk` | Discovers `SKILL.md` files in `skills/<name>/`; exposes `load`/`list`/`use_skill`/`preload` |
| `workerPlugin` | `@roj-ai/sdk` | Long-running background workers |
| `todoPlugin` | `@roj-ai/sdk` | `create_todo`/`update_todo`/`delete_todo` |
| `contextCompactPlugin` | `@roj-ai/sdk` | Compacts conversation past a token threshold; offloads to disk |
| `limitsGuardPlugin` | `@roj-ai/sdk` | Tracks inference/tool/spawn counters; warns or blocks |
| `resultEvictionPlugin` | `@roj-ai/sdk` | Saves large tool outputs to disk; injects truncated preview. **Add whenever tools may return >10–20k tokens.** |
| `snapshottingPlugin` | not re-exported — add to `index.ts` if needed | JJ-VC snapshots after every tool call (requires JJ) |

**Heuristics:**
- Code-writing? Add `shellPlugin` + `resultEvictionPlugin`.
- Long/dense conversations? Add `contextCompactPlugin`.
- Tools that may run for minutes? Add `limitsGuardPlugin`.
