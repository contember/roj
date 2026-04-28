# Roj

OSS monorepo for the `@roj-ai/*` agent SDK, transport, and clients. Published
as npm packages; consumed both by end-users and the private `roj-platform`
companion repo (CF-native orchestration — lives at `~/projects/contember/roj-platform/`).

## Tech Stack

- Bun monorepo (workspaces), TypeScript (ESM only)
- Zod (validation), Hono (HTTP runtime)
- React 19 + Tailwind 4 (client-react, debug UI components)
- Biome (linting)

## Commands

```bash
# Type-check all packages
bun run ts:build

# Lint
bun run lint
bun run lint:fix           # auto-fix
```

## Project Structure

All `@roj-ai/*` packages live flat under `packages/`:

```
packages/
  sdk/                 # Agent SDK: LLM, sessions, plugin system (@roj-ai/sdk)
                       # + sdk/bun-platform sub-export (Bun fs/process adapter)
  transport/           # WebSocket transport + RPC protocol (@roj-ai/transport)
  shared/              # Shared projections, events, state utils (@roj-ai/shared)
  client/              # Vanilla RPC + platform REST client (@roj-ai/client)
                       # + client/platform sub-export (platform REST contract)
  client-react/        # React hooks + chat components (@roj-ai/client-react)
  debug/               # Debug UI components (@roj-ai/debug)
  cli/                 # CLI for managing sessions and debugging (@roj-ai/cli)
  platform-cli/        # CLI for agent bundle build/upload (@roj-ai/platform-cli)
  standalone-server/   # Single-instance local runtime (@roj-ai/standalone-server)
  sandbox-runtime/     # Bun agent host for E2B (@roj-ai/sandbox-runtime)
  demo/                # Local-only App Builder demo + e2e test (@roj-ai/demo, not published)
```

## Code Conventions

- Biome linter with `useExportType: on` — use `export type` for type-only exports
- `useExhaustiveDependencies` and `useHookAtTopLevel` enforced for React hooks
- No `dangerouslySetInnerHTML` (security rule)

## Module-Specific Context

- `packages/sdk/CLAUDE.md` — Plugin system, event sourcing, transport, session management
- `packages/standalone-server/CLAUDE.md` — Local single-instance runtime with platform-compatible REST shape
- `packages/demo/CLAUDE.md` — App Builder demo + snapshot-based e2e test over standalone-server

## Upstream Sync (webmaster → roj)

- **Upstream repo:** `~/projects/contember/webmaster` (still uses `buresh` naming — kept verbatim in paths below)
- **Last synced commit:** `50a00b44` (2026-04-17)
- **Completed backports:** archived in `docs/archive/backports.md`

```bash
# Check for new upstream changes
cd ~/projects/contember/webmaster
git log --oneline --after="2026-04-17" -- \
  buresh/ \
  packages/worker/src/model/buresh/ \
  packages/worker/src/routes/buresh/
```

### Path mapping

Upstream `buresh/packages/buresh-*` packages land as our `packages/*`:

| Webmaster (buresh-named) | Roj |
|---|---|
| `buresh/packages/buresh-agent-server/` | `packages/sdk/` |
| `buresh/packages/buresh-transport/` | `packages/transport/` |
| `buresh/packages/buresh-shared/` | `packages/shared/` |
| `buresh/packages/buresh-client/` | `packages/client/` |
| `buresh/packages/buresh-cli/` | `packages/cli/` |

Platform-side backports (worker, DO, admin) land in the private `roj-platform`
repo — see its `CLAUDE.md` and `docs/archive/backports.md` there.
