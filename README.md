# Roj

Roj is a TypeScript SDK for building multi-agent LLM applications. You describe
agents (system prompt, model, tools, sub-agents) as a **preset**, run it on a
server, and consume it from a browser with ready-made React hooks and chat
components.

The runtime is event-sourced and plugin-driven: every state change is a domain
event, and almost all behavior — filesystem access, shell, services, todos,
mailbox, compaction — lives in plugins you compose per preset and per agent.

> Status: early. Packages are published as `0.1.x` and the API still moves
> between releases.

## Packages

| Package | Description |
|---|---|
| [`@roj-ai/sdk`](packages/sdk) | Agent runtime — LLM providers, sessions, agents, event store, plugin system, built-in tools |
| [`@roj-ai/transport`](packages/transport) | WebSocket transport + RPC protocol (browser and Bun adapters) |
| [`@roj-ai/shared`](packages/shared) | Shared types, projections, RPC schemas |
| [`@roj-ai/client`](packages/client) | Vanilla RPC client + platform REST client |
| [`@roj-ai/client-react`](packages/client-react) | React hooks (`useChat`, `usePreviewUrl`, session stores) and chat components |
| [`@roj-ai/debug`](packages/debug) | Debug UI components (event timeline, agent tree, LLM calls) |
| [`@roj-ai/standalone-server`](packages/standalone-server) | Single-instance local runtime with a platform-compatible REST + WS surface |
| [`@roj-ai/sandbox-runtime`](packages/sandbox-runtime) | Bun agent host for E2B sandboxes |
| [`@roj-ai/cli`](packages/cli) | REPL + CLI for inspecting sessions, agents, events and LLM calls |
| [`@roj-ai/platform-cli`](packages/platform-cli) | `roj build` / `upload` / `deploy` for agent bundles |
| [`@roj-ai/demo`](packages/demo) | App Builder demo + e2e test (not published) |

Roj is also the OSS core of a hosted platform. The same client packages talk to
either the standalone server or the Cloudflare-hosted platform — only the URL
and auth differ.

## Requirements

- [Bun](https://bun.sh) (the monorepo, the server runtime and the test runner)
- An LLM API key — `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`

## Try it

The demo runs the whole stack locally: an App Builder agent that writes plain
HTML/CSS/JS, serves it from a dev service, and streams the result into a React
SPA with a live preview iframe.

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...

# terminal 1 — API server on :2486
bun run --filter @roj-ai/demo dev:server

# terminal 2 — SPA on :2487
bun run --filter @roj-ai/demo dev:spa
```

Open <http://localhost:2487>. See [`packages/demo/README.md`](packages/demo/README.md)
for the layout and the snapshot-based e2e test.

## Build your own agent

**1. Define a preset.** An agent is a system prompt, a model, plugins and
optional sub-agents. Services (dev servers, watchers) start alongside it.

```ts
// roj.config.ts
import { ModelId, createOrchestrator, createPreset, defineAgent, defineConfig } from '@roj-ai/sdk'
import { filesystemPlugin } from '@roj-ai/sdk/tools/filesystem'
import { shellPlugin } from '@roj-ai/sdk/tools/shell'

const builder = defineAgent({
	name: 'builder',
	system: 'You build small web apps from a description.',
	model: ModelId('anthropic/claude-haiku-4.5'),
	services: [{
		type: 'dev',
		description: 'Preview server',
		command: ({ port }) => `bunx serve -l ${port} .`,
		autoStart: true,
		readyPattern: 'Accepting connections',
	}],
	plugins: [filesystemPlugin.configureAgent({ directoryListing: { maxDepth: 3 } })],
	tools: [],
	agents: [],
})

export default defineConfig({
	presets: [createPreset({
		id: 'app-builder',
		name: 'App Builder',
		workspaceDir: '/tmp/roj/sessions/{sessionId}',
		plugins: [shellPlugin.configure({ cwd: '/tmp/roj/sessions' })],
		orchestrator: createOrchestrator({ ...builder, agents: [] }),
	})],
})
```

**2. Run it.** The standalone server hosts the preset and exposes the platform
REST + WebSocket shape on `:2486`.

```bash
bunx roj-standalone roj.config.ts
```

**3. Consume it.** `useChat` handles the WebSocket connection, message stream,
agent questions, attachments and service readiness.

```tsx
import { MessageInput, MessageList, useChat } from '@roj-ai/client-react'

function Chat({ instanceId, sessionId }: { instanceId: string; sessionId: string }) {
	const chat = useChat({
		platformUrl: 'http://localhost:2486',
		instanceId,
		sessionId,
		token: '', // standalone has no auth — bind to localhost
		services: ['dev'],
	})

	return (
		<>
			<MessageList messages={chat.messages} isAgentTyping={chat.isAgentTyping} />
			<MessageInput disabled={!chat.isConnected} />
		</>
	)
}
```

Instances and sessions are created with `createRojClient` from
`@roj-ai/client/platform` — see [`packages/demo/spa/App.tsx`](packages/demo/spa/App.tsx).

### Inspecting a running session

```bash
bun run packages/cli/src/main.ts                       # REPL against http://localhost:2486
bun run packages/cli/src/main.ts agents <sessionId>    # agent tree
bun run packages/cli/src/main.ts events <sessionId>    # domain events
bun run packages/cli/src/main.ts llm-calls <sessionId> # LLM call log
```

## Configuration

The server reads these environment variables (see
[`packages/sdk/src/config.ts`](packages/sdk/src/config.ts)):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `2486` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_PATH` | `./data` | Event store, workspaces, local registry |
| `PERSISTENCE` | `file` | `file` or `memory` |
| `ANTHROPIC_API_KEY` | — | Anthropic provider |
| `OPENROUTER_API_KEY` | — | OpenRouter provider (fallback) |
| `DEFAULT_MODEL` | `anthropic/claude-haiku-4.5` | Model when a preset does not set one |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `console` | Logging |

Per-preset and per-agent settings (plugins, tools, workspace, services) live in
`roj.config.ts`, not in the environment.

## Development

```bash
bun install

bun run ts:build     # type-check + build all packages
bun run ts:watch     # incremental
bun run lint         # Biome
bun run lint:fix
bun test             # package tests
```

Conventions: ESM only, `export type` for type-only exports, Biome for linting.
`packages/sdk` is excluded from Biome and keeps its own conventions.

## Releasing

Tag a commit on clean `main` — [`publish.yml`](.github/workflows/publish.yml)
publishes every public package to npm.

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — repo map and conventions
- [`packages/sdk/CLAUDE.md`](packages/sdk/CLAUDE.md) — plugin system, event sourcing, transport
- [`packages/standalone-server/CLAUDE.md`](packages/standalone-server/CLAUDE.md) — REST surface, git layout, local registry
- [`packages/demo/CLAUDE.md`](packages/demo/CLAUDE.md) — demo and snapshot e2e test
