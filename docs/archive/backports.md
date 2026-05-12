# Completed Backports (webmaster → buresh-cloud)

All backports below were completed as of 2026-03-30 (upstream commit `7f6e2d20`).

- [x] `ebca9a0e` — session-stats plugin + /status per-session metrics
  - agent-server part was already present at fork time
  - worker/DO: propagated `sessions` through healthCheck → ActivityMonitor → alarm-handler (2026-03-17)
  - skipped: D1 SessionStatsWriter (webmaster-specific central stats DB, buresh-cloud uses DO storage for lifecycle events)
- [x] `2fb46255` — onError plugin hook for agent error notification — already present in buresh-agent-server at fork time
- [x] `3fbe2557` — relax creation state transitions — N/A (creation-state-service doesn't exist in buresh-cloud, webmaster/redo-specific)
- [x] `41fc1d43` — update @openrouter/sdk 0.3.15→0.9.11 — N/A, SDK removed in cc099560
- [x] `b8ab2b06` — send error message to parent even without sendCompletionMessage (mailbox plugin)
- [x] `c3d32e40` + `65a9dee0` + `16a34ecb` + `0d87ebf7` — multi-channel session support (WhatsApp routing through buresh sessions, handleIncomingMessage/handleChannelUpload on project-do)
- [x] `b4a07e15` + `a92b0fc4` + `101d0c24` + `d8e76e4e` — Anthropic API provider with routing, model normalization, config validation
- [x] `cc099560` — replace LLM SDKs with raw fetch, add curl export (removed @openrouter/sdk and @anthropic-ai/sdk)
- [x] `911f2b21` — snapshot-cached integration tests for LLM providers
- [x] `53fcb330` — remove async stats fetch, use sync metrics from LLM response (removed openrouter-stats.ts, llm_stats_received event)
- [x] `349fcb97` — track LLM provider name through events, stats, and debug UI
- [x] `d32160b4` — propagate Anthropic API key to agent sandboxes
- [x] `10d895b9` + `b05997b6` — style: format
- [x] `71fe057f` — add missing byProvider field to emptyMetrics (event-store)
- [x] `e88cf573` — remove react-router-dom from @buresh/client, add DebugContext (router-agnostic debug UI)
  - skipped: worker SPA DebugLayout (buresh-cloud has no worker SPA, consumers provide own DebugContext)
- [x] `be6e5ed4` — replace z.intersection with z.object in worker command tools
- [x] `3059a929` — add cost calculation to Anthropic provider
- [x] `fcf12e24` — always convert images to JPEG before sending to LLM (vips-resizer)
- [x] `fd495539` — run LLM integration tests from snapshots without API keys
- [x] `628bc215` — dockerize local dev — N/A (webmaster-specific docker infra)
- [x] `344dc5cb` — dep bumps (bindx, hono, kysely, biome) — N/A (webmaster root deps)
- [x] `25cc7f1b` + `5cc91951` — variant publish flow + rebase before publish — redesigned as option on existing publish()
- [x] `7d9f8250` — configurable LOCAL_BASE_URL — N/A (webmaster-specific local dev config)
- [x] `81e7ca67` — use git init -b main for local sandbox repos
- [x] `402d62e5` — resolve bwrap bind-mount paths to absolute (skip packages/agent/)
- [x] `55dbf9a8` — track sub-agent phases via definitionName in status notifications (skip DashboardPage refactor)
- [x] `7f6e2d20` — preview-ready email notification — skipped (needs systematic redesign, not hardcoded to webmaster flow)
- [x] `7d9f8250` — configurable local base URL + Docker networking — N/A (webmaster-specific local dev)
- [x] `81e7ca67` — git init -b main — already backported in previous sync
- [x] `402d62e5` — bwrap bind-mount absolute paths — already backported in previous sync
- [x] `55dbf9a8` — sub-agent definitionName tracking — already backported in previous sync
- [x] `9e296934` — allow resuming errored agents (resume_from_error decision, extend resume to errored status, include in session_restarted recovery)
- [x] `e5c5b473` — extract helpers + 502 retry in dev preview proxy (resolveSandbox, proxyFetch, buildResponse helpers; retry once on 502 with invalidateRuntime)
- [x] `1a0d4c5d` — consume mailbox messages on failed inference to prevent infinite loop (move markConsumed before error check, preserve pendingMessages in conversationHistory on inference_failed)

## 2026-04-14 sync (to `c11b95da`)

- [x] `613a5475` — bound E2B connectSandbox request timeout to 15s (e2b-sandbox.ts)
- [x] `ed202b4d` — guard orphan service kill against PID reuse (services plugin, Linux /proc lookup)
- [x] `0108a052` + `c88b807e` + `cf7a7b90` — preserve service port in projection, hide in prompt for stopped/failed/paused services
- [x] `80380cd0` + `e2b9c446` — reuse isForbiddenOnClosed in guardWriteToClosed (base-event-store)
- [x] `eceb8668` + `3fc3b981` + `5222a279` — sandbox pause chain net-zero; upstream reverted to pre-chain state, buresh-cloud already matched, no change
- [x] `911509e3` — detect default branch in git-status snapshot (git-status plugin)
- [x] `ff4ec18d` — tighten git-status plumbing (no-await first tick, explicit WS forwarding, drop clearGitStatus)
  - skipped: `app/lib/hooks/use-live-git-status.ts` — webmaster app-only, buresh-cloud has no equivalent
- [x] `2534f8f9` — propagate session rename to running sandbox (session-service)
- [x] `613771ce` — dev RPC auth bypass + structured tracing
  - adapted: x-dev-auth header handled in `InstanceAuthenticator` (not `BureshRpcHandler` — doesn't exist in buresh-cloud)
  - [DO RPC] console logs added to `SessionService.callSessionRpc`
  - skipped: span() tracing (buresh-cloud doesn't use @app/logger), dev.ensureSessionAlive/getServiceUrl (already public instance methods)
- [x] `c127f9ad` — per-project event log in DO SQLite
  - added: `do/observability/event-logger.ts`, migration v5, `event_log` table type
  - added: DO `getEventLog`/`logEvent` methods + prune on alarm
  - instrumented: SessionService.callSessionRpc, AgentRpcProxy, SandboxLifecycle (pause/terminate/restartAgent), BureshWebSocketGateway (upgrade/close/error), InstanceRpc routes
- [x] `08b0825e` — debug-session CLI + DEBUGGING.md (adapted to x-dev-auth header + `/api/v1/instances/<id>/rpc`; skipped postgres + DO sqlite direct access)
- [x] `466280dd` — admin event log card (new `debug.getEventLog` admin RPC, EventLogCard component, wired into DebugDashboard)

Skipped (not relevant to buresh-cloud):
- `8d554f90` — lopata bump (buresh-cloud has its own toolchain)
- Anything under webmaster's `app/` directory

## 2026-04-17 sync (to `50a00b44`)

- [x] `a964a73e` — remove maxTurnsWithoutProgress from limits-guard (config, limit-guard, plugin, agent-detail-projection; no redo preset in buresh-cloud)
- [x] `9c739f74` — commit inference turn before pausing on afterInference (emit inference_completed before agent_paused in agent.ts; append-instead-of-overwrite in state.ts inference_started reducer; two new session.test.ts tests)
- [x] `513155a0` — reset all counters on agent resume + bump default maxTurns 50→100 (limits-guard plugin + agent-detail-projection)
- [x] `f217206d` — disable CF cache on dev preview proxy (`cf.cacheTtl: 0` on proxyFetch, `Cache-Control: no-store` on buildResponse)
- [x] `d5d7f373` — N/A. buresh-cloud `SandboxLifecycle.getOrCreateSandbox` uses try/finally with await rather than `.finally()` chain, so the upstream unhandled-rejection path doesn't apply.
- [x] `50a00b44` — drop handler_started events entirely, skip handler_completed when result is null (except onStart, which the reducer needs); drop session_handler_started + success-case session_handler_completed in callSessionReadyHooks (keep error case)

Skipped (not relevant to buresh-cloud):
- `b2784d3d` — webmaster CLAUDE.md refresh after core/ refactor (paths documented separately in buresh-cloud)

## Ad-hoc backports past `50a00b44`

- [x] `41bab476` — always skip `node_modules` in `list_directory` and load `.gitignore` from the workspace/session root containing the listed path (filesystem helpers + plugin)

## 2026-05-12 sync (to `96212da4`)

- [x] `20610be3` — fix(buresh-client): hide system message bodies from user chat view; show a generic "AI is updating your project" chip with `SparklesIcon` (client-react `UserMessage.tsx`)
- [x] `26bfe1da` — feat(buresh): track `lastInferenceMetrics: LLMMetrics` on `AgentState` and populate it from the `inference_completed` event reducer
- [x] `708f4ba4` — fix(buresh): use provider-reported `promptTokens` for the compaction trigger; `ContextCompactor.needsCompaction`/`compactIfNeeded` accept an optional `lastActualPromptTokens`, plumbed from `ctx.agentState.lastInferenceMetrics?.promptTokens` in the plugin's `beforeInference` hook
- [x] `77b915a6` — feat(buresh): inline summarization via the agent's own model
  - new `Agent.runAuxiliaryInference(extraMessages)` reusing system prompt, tools, and full prefix (cache-aware `applyCacheBreakpoint`)
  - exposed on `AgentContext` as `runAuxiliaryInference`
  - `ContextCompactor` constructor no longer takes an `LLMProvider`; `compact`/`compactIfNeeded` take a `RunInferenceFn` callback; the agent's prompt cache covers everything but the trailing summarize instruction
  - summary message role flipped `system → user` so it threads into chat history naturally
  - `CompactionConfig.model` marked `@deprecated` (kept for preset type-compat)
  - integration test detects summarization by the trailing `[CONTEXT COMPACTION REQUEST]` user message
- [x] `6e5eadd0` — feat(buresh): per-agent compaction config overrides via `.agentConfig<ContextCompactAgentConfig>()`; compactor is built per `beforeInference` from merged session + agent config
- [x] `c19279bc` — feat(buresh): support Anthropic 1h prompt cache TTL per agent
  - `LLMMessageCacheControl.ttl?: '5m' | '1h'`
  - `applyCacheBreakpoint(messages, suffix, ttl?)` propagates `ttl` into the marker
  - Anthropic provider maps the marker into `cache_control.ttl` on the last content block
- [x] `96212da4` (SDK part) — expose `cacheTtl?: '5m' | '1h'` on `BaseAgentConfig` and runtime `AgentConfig`; propagated in `Session.buildAgentConfig` for orchestrator / communicator / agent; both `applyCacheBreakpoint` call sites in `agent.ts` pass `this.config.cacheTtl`
  - skipped: `packages/agent/src/presets/redo.ts` (preset lives in roj-platform; if needed there it's a separate backport)

Skipped:
- `3b70f0cd` — chore(deps): bumps `@nuasite/nua`, `lopata`, `lucide-react`, `marked` in the upstream client; roj manages package versions independently
- `1a2c7d8f` — chore: format-only changes to `buresh/CLAUDE.md` (not the roj CLAUDE.md)

## Ad-hoc backports past `96212da4`

- [x] `3859e8a8` — fix(buresh): preserve agent-visible path in `read_file` image_url. Old code stored `file://<realPath>` (resolved disk path); on re-resolution via `imageProcessor.resolveContent` → `fileStore.realPath()` the sandboxed store rejected it, so every later turn referencing the image got `[Image unavailable: …]`. Fix uses `file://${input.path}` so re-resolution succeeds. Other producers (`image-classifier`, debug UI's `fileUrlToProxyUrl`) already handled / produced agent-visible paths; non-sandboxed mode is unaffected. Regression test added in `filesystem.integration.test.ts`.
