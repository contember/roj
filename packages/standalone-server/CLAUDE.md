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
- `instances.create/list/get/status/archive` — singleton
- `sessions.create/list` — delegates to SDK `callManagerMethod`
- `tokens.create` — returns `{ token: '' }`

Not implemented (return `method_not_found`):
- `bundles.*`, `sessions.publish`, `files.upload`, `resources.*`

Files/resources will be added when a concrete consumer needs them.
