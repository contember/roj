# @roj-ai/standalone-server

Single-machine, single-instance runtime for the roj SDK. Speaks the same
REST + WebSocket shape as the Cloudflare-hosted platform, so
`@roj-ai/client` and `@roj-ai/client-react` work unchanged against it.

## Not a replacement for the platform

What this does:
- Runs one SDK agent host in-process
- Exposes a platform-compatible URL shape under `/api/v1/...`
- Path-based preview proxy for dev services

What this does NOT do:
- Multi-tenancy (one `instanceId` per process, generated on startup)
- Sandbox isolation (agent runs directly on the host)
- Authentication (no tokens, no cookies — bind to localhost)
- Bundle management (`bundles.*` RPC returns `method_not_found`)
- Publishing (`sessions.publish` returns `method_not_found`)

## URL shape

```
POST /api/v1/rpc                              — platform RPC (singleton)
POST /api/v1/instances/{id}/rpc               — agent RPC (sessions.get, user-chat.*)
POST /api/v1/instances/{id}/sessions/{sid}/upload — session file upload
WS   /api/v1/instances/{id}/ws                — live events (?sessionId=)
ANY  /api/v1/instances/{id}/preview/{code}/*  — dev service proxy
POST /api/v1/instances/{id}/exchange          — noop
GET  /health                                  — health check
```

`{code}` in the preview proxy maps to service type (e.g. `dev`). The first
running session with a matching service wins.

The standalone routes preview by **path only**, not by Host header — it has
no wildcard subdomain awareness. Browser code that builds preview URLs
(e.g. `usePreviewUrl` from `@roj-ai/client-react`) must pass
`pathBased: true` so `buildPreviewUrl` produces
`{platformUrl}/api/v1/instances/{id}/preview/{code}/` rather than the
default `dev-{hex}-{code}.{baseDomain}` form. The flag has no effect
against roj-platform local dev (which routes wildcards via wrangler).

## Embedding / testing

`startStandaloneServer(options)` returns a `StandaloneHandle` with:

- `port` — resolved listen port (useful when `config.port === 0`)
- `sessionManager` — underlying `SessionManager`; exposed so tests can call
  `getSession()` + `waitForAllAgentsIdle()` without reaching into internals
- `instance`, `config`, `logger`, `shutdown()`

For deterministic e2e tests, inject `llmMiddleware: [createSnapshotLLMMiddleware({ snapshotsDir })]`
from `@roj-ai/sdk/llm/snapshot-middleware` — see `packages/demo/tests/` for a
worked example.

## Platform RPC surface

Implemented:
- `instances.create/list/get/status/archive` — singleton; `metadata` and
  `autoCreateSession` honored (last-write-wins on metadata since instance is
  process-singleton)
- `sessions.create/list` — delegates to SDK `callManagerMethod`. `initialPrompt`
  is delivered as a `user-chat.sendMessage` after creation, mirroring
  roj-platform `activatePendingSession`. `resourceIds` are matched against
  `localResources` slugs (see below).
- `tokens.create` — returns `{ token: '' }`

Not implemented (return `method_not_found`):
- `bundles.*`, `sessions.publish`, `files.upload`, `resources.*`,
  `sessionFiles.createDownloadUrl`

Files/resources will be added when a concrete consumer needs them.

## Local resource registry

The platform's resource service is replaced by a tiny on-disk registry
configured in the user's `roj.config.ts`:

```ts
export default defineConfig({
  presets: [...],
  localResources: [
    { slug: 'kurikulum-template', path: './fixtures/kurikulum-template.zip' },
  ],
})
```

`path` resolves relative to the config file. At session start the server
resolves resources to inject in this order, mirroring roj-platform's
project-init:

1. `input.resourceIds` (from `instances.create.autoCreateSession` or
   `sessions.create`) — each id is matched against a `localResources` slug.
   Unmatched ids are warned-and-skipped (they typically come from a remote
   resource registry that doesn't exist locally).
2. If nothing matched, falls back to `preset.defaultResourceSlugs`.

For each resolved resource, the server reads the file and calls
`resources.inject` directly on the session — same plugin method the SDK's
`POST /sessions/:sid/inject-resource` HTTP route uses, just bypassing the
URL fetch.

Order at session start: SDK creates session → resources injected (sync,
in order) → `initialPrompt` sent. The agent's first inference always sees
the full workspace.
