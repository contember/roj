---
name: Clients & CLI surface
description: createRojClient, useChat and other React hooks, roj/roj-cli commands, standalone-server. Read when wiring an SPA/server to a deployed preset, or shipping a preset bundle.
---

# Clients & CLI surface

- `@roj-ai/client` — typed REST + RPC (platform or standalone)
- `@roj-ai/client-react` — React hooks + components
- `@roj-ai/cli` (`roj-cli`) — local debug / scripting
- `@roj-ai/platform-cli` (`roj`) — bundle build/upload
- `@roj-ai/standalone-server` — local dev runtime
- `@roj-ai/debug` — inspector UI

## @roj-ai/client

The single typed entry point for talking to a deployed preset (platform or standalone — same URL contract). `createRojClient` lives in the `/platform` sub-export, not the package root:

```ts
import { createRojClient } from '@roj-ai/client/platform'

const roj = createRojClient({ url, apiKey })   // platform: API key. standalone: any string.
```

The package root (`@roj-ai/client`) exports the lower-level `createApiClient` / `instanceApi` building blocks; for typical SPA / server-side use you want `/platform`.

`roj.*` namespaces:

| Namespace | Methods |
|---|---|
| `instances` | `create`, `get`, `getStatus`, `list`, `archive` |
| `sessions` | `create`, `list`, `publish`, `rpc<T>({ instanceId, sessionId, method, input })` |
| `tokens` | `create({ instanceId, expiresIn?, origin?, meta? })` → `{ token, expiresAt }` |
| `bundles` | `list`, `delete` |
| `resources` | `create`, `addRevision`, `get`, `list`, `delete` |
| `sessionFiles` | `createDownloadUrl({ instanceId, sessionId, scope: 'workspace'\|'session', path, ttlSeconds? })` |
| `files` | `upload(file, filename?)` → `{ fileId, filename, mimeType, size, r2Key, deduped }` |

**`sessions.rpc`** is the generic call for any plugin method exposed through the session — `method` is `'<plugin>.<methodName>'` (e.g. `'scormExport.export'`).

### URL contract (same for platform + standalone)

| Endpoint | Auth |
|---|---|
| `POST /api/v1/rpc` | platform API key bearer |
| `POST /api/v1/instances/{id}/rpc` | instance token (minted via `tokens.create`) |
| `POST /api/v1/instances/{id}/sessions/{sid}/upload` | instance token |
| `WS /api/v1/instances/{id}/ws?token=…` | instance token |
| `ANY /api/v1/instances/{id}/preview/{code}/*` | preview cookie / dev token |
| `GET /health` | open |

### Building custom RPC contracts

The platform's `PlatformMethods` type lives in `roj/packages/client/src/platform/methods.ts`. You can build your own typed contract on top of `createRpcClient`:

```ts
import { createRpcClient, defineMethods, method } from '@roj-ai/client/platform'

const myMethods = defineMethods({
  'foo.do': method<{ x: number }, { y: string }>(),
})
const client = createRpcClient<typeof myMethods>('http://localhost:2486', { headers: { Authorization: 'Bearer ...' } })
const r = await client.call('foo.do', { x: 1 })
```

---

## @roj-ai/client-react

Hooks and components for SPAs. The demo (`packages/demo/spa/App.tsx`) is the canonical reference.

### `useChat`

The main hook — returns a chat state object plus actions.

```ts
const chat = useChat({
  platformUrl: 'http://localhost:2486',
  instanceId,
  sessionId,
  token: 'string-or-refresher-object',  // see token shapes below
  autoConnect: true,                    // default
  services: ['dev'],                    // services to start at session boot
  onMessage: (type, payload) => {…},     // catch-all for custom WS message types
})
```

`token` accepts either a string or a refreshing token object:

```ts
{
  initial: { token: string, expiresAt?: number },
  refresh: () => Promise<{ token: string, expiresAt?: number }>,
  refreshLeadMs?: number,
}
```

Returns:

```ts
{
  connectionStatus, isConnected, error,
  messages, pendingQuestions, isAgentTyping, isAgentConnected,
  pendingAttachments, services,                   // Map<type, { serviceType, status, port?, code? }>
  initStatus, initSteps, currentToken,
  sendMessage(content), uploadFile(file), removeAttachment(uploadId),
  answerQuestion(questionId, answer), setDraftAnswer(qid, value), submitAllAnswers(),
}
```

### Other hooks

| Hook | Purpose |
|---|---|
| `useSessionStore(selector)` | chat / questions / services / sessionState slices |
| `useConnectionStore(selector)` | WS connection state, message handlers |
| `useAutoConnect()` | global auto-reconnect manager (mount once) |
| `usePreviewUrl(opts)` | signed iframe URL from live service registry |
| `useSessionState(key)` / `useSessionStateValue(key, default)` | read session state |
| `useUpdateSessionState()` | `(updates) => Promise<void>` |

### Components

Unstyled-ish primitives — style with Tailwind:

- `MessageList`, `MessageInput`, `QuestionnairePanel`
- Form inputs: `TextInput`, `SingleChoice`, `MultiChoice`, `Rating`, `Confirm`
- Helpers: `QuestionItem`, `QuestionnaireSummary`

---

## @roj-ai/platform-cli (`roj`)

Bundle build + upload. Auth: `--api-key` / `ROJ_API_KEY`. URL: `--url` / `ROJ_PLATFORM_URL`.

| Command | What it does |
|---|---|
| `build [config] --out <path>` | Bundle `roj.config.ts` to a single JS file (default `dist/bundle.js`). CF Worker-compatible module exporting the presets. |
| `upload <bundle.js> --name <name>` | Preflight `{ name, contentHash }` for dedup; retries with FormData blob on 409+`bundle-required`. Returns `{ bundleSlug, revisionId, deduped?, noop? }`. |
| `deploy [config] --name <name>` | `build` + `upload`. |
| `resource <path\|dir> --slug <slug> [--name] [--description] [--label]` | Upload file/dir (auto-zipped) as resource. Deduped by content hash; reusing a slug creates a new revision. |

---

## @roj-ai/cli (`roj-cli`)

Local debug / scripting. URL: `--url` / `ROJ_URL` (default `http://localhost:2486`). Auth: none for localhost; platform mode needs an instance token.

| Command | What it does |
|---|---|
| `presets` | list presets |
| `sessions [--status active\|closed\|errored]` | list sessions |
| `session-create <presetId>` / `session-get` / `session-close <sessionId>` | session lifecycle |
| `messages <sessionId>` | dump chat |
| `send <sessionId> <message> [--wait]` | send user message; `--wait` blocks for reply |
| `answer <sessionId> <questionId> <answer>` | answer pending `ask_user` |
| `events <sessionId> [--type] [--agent] [--limit N]` | event log query |
| `agents <sessionId>` / `agent <sessionId> <agentId>` | agent tree / single |
| `mailbox` / `timeline` / `metrics` / `preset-agents` `<sessionId>` | introspection |
| `llm-calls <sessionId> [--limit N]` / `llm-call <sessionId> <callId>` | LLM log |
| `debug-send <sessionId> <agentId> <msg> [--from <sender>]` | inject debug message |
| `spawn-agent <sessionId> <defName> <parentId> [--message <msg>]` | spawn sub-agent |

---

## @roj-ai/standalone-server

Single-Bun-process server, same URL contract as platform.

```ts
const handle = await startStandaloneServer({
  presets: [myPreset],
  config: { port: 2486 },
  instanceId: 'local',
  instanceName: 'Local',
  onBeforeStart: ({ config, logger }) => {},   // register custom routes
  onShutdown: () => {},
})
// handle = { config, logger, instance, port, sessionManager, shutdown() }
```

For local dev (no platform auth / E2B), desktop embedding, E2E tests (with `createSnapshotLLMMiddleware`). Same `@roj-ai/client(-react)` code talks to it unchanged.

---

## @roj-ai/debug

A drop-in inspector UI. Polls the session's domain events and renders agent tree, mailbox, timeline, LLM calls, files, logs, user chat, raw events.

```tsx
import { EventPollingProvider, DebugContext, DebugShell } from '@roj-ai/debug'

<EventPollingProvider interval={1000}>
  <DebugContext>
    <DebugShell>
      {/* renders nav + the active page (DashboardPage, AgentsPage, …) */}
    </DebugShell>
  </DebugContext>
</EventPollingProvider>
```

Pages exported individually too (`DashboardPage`, `AgentsPage`, `AgentDetailPage`, `CommunicationPage`, `TimelinePage`, `LLMCallsPage`, `LLMCallPage`, `LogsPage`, `MailboxPage`, `FilesPage`, `UserChatPage`, `EventsPage`).

Pollability comes from the platform / standalone exposing query RPC methods (debug plugins). No persistent listener — you control the poll interval.

---

## Integration recipes

**SPA boot:**

```ts
const roj = createRojClient({ url, apiKey })
const { instanceId } = await roj.instances.create({ bundleSlug, name: 'my-instance' })
const { sessionId } = await roj.sessions.create({ instanceId, presetId: 'my-preset' })
const { token } = await roj.tokens.create({ instanceId, expiresIn: 3600 })

const chat = useChat({ platformUrl: url, instanceId, sessionId, token })
```

For long-lived UIs, pass `token: { initial, refresh }` so `useChat` re-mints before expiry.

**Server-side RPC** to a plugin method: `roj.sessions.rpc<TOut>({ instanceId, sessionId, method: 'scormExport.export', input })`.

**Tests against standalone:** `startStandaloneServer({ presets, config: { port: 0 } })` then drive via the same client; call `handle.shutdown()` after.

**Deploy pipeline:** `roj deploy roj.config.ts --name my-bundle` and `roj resource ./template --slug my-template --label v2` with `ROJ_PLATFORM_URL` + `ROJ_API_KEY` env. Bundle revision auto-promotes on next instance provisioning.
