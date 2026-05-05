---
name: roj
description: Author and consume roj presets — the @roj-ai/* agent SDK, transport, clients. Use when writing or reviewing a preset (createPreset / defineAgent / createOrchestrator), authoring a custom plugin (definePlugin), wiring filesystem / shell / resources / uploads / services / sessionState, building system prompts, debugging path or sandbox issues, shipping a bundle (`roj build` / `upload` / `resource` / `deploy`), or integrating a host app via @roj-ai/client / @roj-ai/client-react / @roj-ai/standalone-server / @roj-ai/debug. Triggers also include working under `~/projects/contember/roj/packages/*` or in repos consuming `@roj-ai/*` (roj-platform, webmaster's `packages/agent`, scorm-preset, similar).
---

# Roj presets

A *preset* is a self-contained agent definition (orchestrator + sub-agents + plugins + services) bundled into a single JS file. Hosts: Cloudflare Workers + E2B (roj-platform), or a Bun process via `@roj-ai/standalone-server` (local).

## Mental model

```
Host app (SPA) ──REST/WS──▶ Platform / standalone-server ──spawns──▶ Sandbox running preset
                                                                       │
                                                                       └─ orchestrator ──▶ sub-agents
                                                                              │ tools  ◀── plugins
```

Three things define an agent's capabilities:

1. **Agent definition** — system prompt, model, sub-agents, tools, services.
2. **Plugins on the preset** — tools, methods, hooks, persisted state, event reducers.
3. **Session environment** — `sessionDir`, `workspaceDir`, `sandboxed` flag.

Each sub-package has its own `CLAUDE.md` with internals; the references in this skill cover the consumer-facing API.

## A first preset

```ts
import { defineConfig } from '@roj-ai/sdk/user-config'
import { createOrchestrator, createPreset, defineAgent, ModelId } from '@roj-ai/sdk'
import { filesystemPlugin } from '@roj-ai/sdk/tools/filesystem'
import { shellPlugin } from '@roj-ai/sdk/tools/shell'

const builder = defineAgent({
  name: 'builder',
  system: `You build small web apps. Write files into {{workspaceDir}}.`,
  model: ModelId('anthropic/claude-haiku-4.5'),
  services: [{
    type: 'dev',
    description: 'Dev server',
    command: ({ port }) => `bunx serve -l ${port} .`,
    autoStart: true,
    readyPattern: 'Accepting connections',
  }],
  plugins: [filesystemPlugin.configureAgent({ directoryListing: { maxDepth: 3 } })],
})

export const myPreset = createPreset({
  id: 'app-builder',
  name: 'App Builder',
  workspaceDir: '/tmp/myapp/sessions/{sessionId}',
  plugins: [shellPlugin.configure({ cwd: '/tmp', sandbox: { enabled: true, network: true } })],
  orchestrator: createOrchestrator(builder),
})

export default defineConfig({ presets: [myPreset] })
```

`userChatPlugin`, `mailboxPlugin`, `agentsPlugin`, `uploadsPlugin`, `filesystemPlugin`, `sessionStatePlugin` and ~10 others are auto-registered — only opt-in plugins (e.g. `shellPlugin`) and per-agent overrides go on `plugins`. Full split in `references/presets.md`.

```bash
roj build roj.config.ts --out dist/bundle.js
roj upload dist/bundle.js --name my-app-builder
```

Or local: `await startStandaloneServer({ presets: [myPreset], config: { port: 2486 } })` and point an SPA at it via `useChat` (see `references/clients-and-cli.md`).

## When to read each reference

| Task | Reference |
|---|---|
| Plugins, services, resources, uploads, session state | `presets.md` |
| Custom plugin authoring (`definePlugin`) | `plugins.md` |
| System prompts, multi-agent orchestration, `ask_user`, attachments | `prompts.md` |
| `shellPlugin` config, virtual paths, bwrap, roj-platform worktrees | `paths-and-sandbox.md` |
| `@roj-ai/client`, `useChat`, CLI, standalone-server, debug UI | `clients-and-cli.md` |

If unsure, start with `presets.md` — it cross-links the others.

## Workflow checklist

1. **Sketch agent topology first.** One orchestrator + sub-agents, each with a single named artifact. If you can't name the artifact, the design is vague.
2. **Check built-in plugins** in `presets.md` before writing custom ones.
3. **Decide path layout.** `workspaceDir` = user-facing artifact surface; `sessionDir` = ephemeral plans/notes.
4. **Write prompts** per `prompts.md`: phases on the orchestrator; Role/Inputs/Rules + "What you do not do" on sub-agents.
5. **Test against `@roj-ai/standalone-server`** first; E2B adds latency and a failure mode.
6. **`shellPlugin` defaults `defaultEnabled: true`** — opt agents out explicitly if they shouldn't shell.
7. **Resources ≠ bundle.** Code → `roj upload`; templates/assets/fixtures → `roj resource`.
