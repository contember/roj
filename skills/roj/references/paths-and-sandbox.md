---
name: Paths, sandbox & shell
description: How sessionDir/workspaceDir, virtual paths, FileStore, bwrap, network and binds fit together. Read when configuring shellPlugin or debugging path/permission errors.
---

# Paths, sandbox & shell

Two roots per session: `sessionDir` (ephemeral, always present) and `workspaceDir` (artifact surface, optional). In sandboxed mode the agent sees them at virtual paths; FileStore-backed tools translate transparently, raw shell does not. Get the map wrong and reads/writes/`git` fail subtly.

## The two roots

| Root | Purpose | Default |
|---|---|---|
| **`sessionDir`** | plans, notes, plugin state, uploads, intermediate artifacts | `${basePath}/sessions/${sessionId}` |
| **`workspaceDir`** | the code/project the agent edits | `preset.workspaceDir` with `{sessionId}` interpolated, or host override |

Workspace-scoped FileStore ops fail with `No workspace directory configured` when `workspaceDir` is absent. Resolution order: `sessions.create` option → `preset.workspaceDir` (with `{sessionId}`) → undefined. Forking requires `{sessionId}` in `preset.workspaceDir`.

## Template variables

`{{sessionDir}}` and `{{workspaceDir}}` in agent system prompts substitute to `FileStore.getRoots()`:

| `sandboxed` | session | workspace |
|---|---|---|
| `false` | real `sessionDir` | real `workspaceDir` |
| `true` | `/home/user/session` | `/home/user/workspace` |

`{{workspaceDir}}` is left as-is when no workspace is configured, so prompts work in either mode.

---

## FileStore scopes

| Scope | Relative paths resolve against | Accessor |
|---|---|---|
| `'full'` (default) | virtual or real | `ctx.files` |
| `'session'` | `sessionDir` | `ctx.files.session` |
| `'workspace'` | `workspaceDir` (undefined if absent) | `ctx.files.workspace` |

```ts
await ctx.files.session.write('notes/plan.md', '...')
await ctx.files.workspace?.list('src')
```

Scoped stores prevent writing into the wrong tree. `getRoots()` returns *display* roots — virtual when sandboxed, real otherwise — for formatting paths shown to the LLM or user.

---

## Sandboxed virtual paths

Bwrap binds:

```
/                  ← / (--ro-bind)
/dev, /proc        ← from host
/tmp, /home, /root ← tmpfs (host home is masked)
real sessionDir    → /home/user/session   (rw)
real workspaceDir  → /home/user/workspace (rw)
extraBinds[]       → as configured
```

`/home` being tmpfs is why `extraBinds` exists: `~/.gitconfig`, credential helpers, extra project dirs all need explicit binds. **Network is off by default** (`--unshare-all`); enable with `sandbox: { network: true }`.

## Uploads layout

`uploadsPlugin` writes each upload to `{sessionDir}/uploads/<uploadId>/<filename>` + sibling `meta.json`. The agent sees an auto-injected synthetic user message with `<attachment uploadId="…" filename="…" basePath="/home/user/session/uploads/<uploadId>">extracted text</attachment>` blocks.

Read raw bytes with `<basePath>/<filename>`. **Don't list `{{sessionDir}}/uploads/`** — it returns UUID directories.

---

## Shell plugin & bwrap

```ts
import { shellPlugin, type ShellPresetConfig } from '@roj-ai/sdk/tools/shell'

const shell: ShellPresetConfig = {
  cwd: '/tmp',                                    // see note below
  sandbox: { enabled: true, network: true },
  extraBinds: [
    { path: '/home/user/project', mode: 'rw' },   // bare git for worktrees
    { path: '/home/user/.gitconfig', destPath: '/home/user/.gitconfig', mode: 'ro' },
  ],
  defaultEnabled: true,                           // gives every agent run_command
}

shellPlugin.configure(shell)
```

| Field | Notes |
|---|---|
| `cwd` | **Mostly inert in sandboxed mode.** When bwrap is enabled, the default cwd inside the sandbox is `/home/user/session`; per-call `input.cwd` (or virtual `/home/user/workspace`) overrides. `config.cwd` is only consulted as the *outer* spawn cwd for the bwrap process itself, with `sessionDir` taking precedence (`executor.ts:355`). |
| `sandbox.enabled` | Default `true`. When `false` (or `sandbox` is unset and `environment.sandboxed` is also false), commands run without bwrap. |
| `sandbox.network` | Default `false`. **Turn on for any preset that runs `bun install`, `npm`, fetches, etc.** |
| `extraBinds` | bind extra paths into the bwrap namespace. `mode: 'rw'` for project trees, `'ro'` for credentials and configs. `destPath` defaults to `path`. |
| `timeout` | Default 30000ms. Override per-call via `input.timeout`. |
| `env` | Extra env vars merged into the command's environment. |
| `defaultEnabled` | Default `true`. **Every agent in the preset gets `run_command` unless explicitly disabled** with `shellPlugin.configureAgent({ enabled: false })`. `tools: []` on the agent definition does not opt the agent out. |

### When you need extraBinds

| Use case | Bind |
|---|---|
| Worktree-based git (roj-platform) | `/home/user/project` rw |
| `git commit` from inside bwrap (author identity) | `/home/user/.gitconfig` ro |
| Credential helper for `git push` | `/home/user/.git-credential-helper` ro (if it exists at session start) |
| Custom toolchain installed outside session | the binary's directory rw or ro |

### Per-call cwd

When the agent calls `run_command`, it passes a virtual `cwd` (in sandboxed mode):

```jsonc
// agent's tool call (sandboxed preset)
{
  "tool": "run_command",
  "input": {
    "command": "bun run build",
    "cwd": "/home/user/workspace"
  }
}
```

In non-sandboxed mode, the agent passes the real path, or omits `cwd` to fall back to `workspaceDir` (`executor.ts:317`). Either way, the agent operates in path namespace returned by `FileStore.getRoots()` — never hand-translate inside a prompt.

---

## Roj-platform integration (git worktrees)

`roj-platform` always overrides `workspaceDir` with a fresh git worktree:

```
/home/user/project           ← bare main (shared)
/home/user/sessions/<sid>/   ← worktree, branch session/<sid>
```

Implications:

1. `preset.workspaceDir` is a no-op default; set it to a sensible local-dev path (e.g. `/tmp/myapp/sessions/{sessionId}`) so the preset still works with standalone-server.
2. `git` from inside bwrap needs `/home/user/project` bound rw (worktree references the bare repo).
3. `git config --global` is set outside bwrap; bind `/home/user/.gitconfig` ro to make it visible inside.
4. `network: true` for `bun install` and any registry fetches.

Mirror webmaster:

```ts
shellPlugin.configure({
  cwd: '/tmp',
  sandbox: { enabled: true, network: true },
  extraBinds: [
    { path: '/home/user/project', mode: 'rw' },
    { path: '/home/user/.gitconfig', mode: 'ro' },
  ],
})
```

If agents don't need shell, omit the plugin entirely — partial config silently misbehaves.
