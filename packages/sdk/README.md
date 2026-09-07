# @roj-ai/sdk

Roj provides event-sourced agent sessions, plugins, and runtime adapters.
This guide describes the SDK boundary for a portable host that moves sessions
between processes. It does not provide a distributed ownership service.

## SDK and host responsibilities

| Capability | SDK | Host |
| --- | --- | --- |
| Resident lifecycle | Activation handles, graceful park, local revoke | Decide when ownership starts and ends |
| Single writer | Serializes writes within one event-store instance | Prevent overlapping writers across instances/processes |
| Ownership fencing | Rejects new work on an unavailable local runtime | Fence stale owners at every shared effect boundary |
| Scheduled work | Arms/cancels wakes and dispatches wake keys | Persist wakes, route to the owner, acknowledge/retry delivery |
| Message retries | Persists optional delivery receipts | Keep a stable delivery ID and original request |
| Recovery | Validates event history and rebuilds session state | Supply storage, backups, credentials, and compatible deployments |

An activation is not a distributed lease or fencing token. Acquire external
ownership **before** activating or accessing a session. The manager can implicitly
activate a session on first access; that convenience does not establish ownership.
Fence event writes, scheduler `wake`/`cancel`, shared file operations, and other
external effects. Local revoke cannot recall an operation already issued to an
external service. Plugins using resources outside SDK guards need host-level
protection too. There is no exactly-once guarantee for external effects.

## Activation and handoff

`SessionManager` exposes:

- `activateSession(sessionId): Result<SessionActivation, DomainError>` — synchronous;
  admits a local tenure, without loading or proving that the session exists.
- `parkSession(handle): Promise<void>` — stops new admission and drains admitted
  work, event writes, tracked resources, cleanup hooks, and scheduler operations.
- `revokeSession(handle): void` — immediately fences local admission and runtime
  scopes, detaches the runtime, and starts best-effort local cleanup.

Keep the exact `SessionActivation` object returned by this manager. It contains a
readonly `sessionId`, but identity is checked: a copied, reconstructed, or foreign
manager's object is invalid. Repeated activation during the same active tenure
returns the same handle. After release, explicit activation returns a new handle.
Calls with an authentic stale handle do not park or revoke its replacement.

Park does not close the persisted session. It runs `onSessionClose` hooks with
reason `parked`; later activation reloads persisted state. Keep external ownership
until park resolves successfully, then release it. A failed or hung park is not a
successful handoff. Revocation rejects a pending park without waiting for hung
work, and uses close reason `revoked`; it is not a drain acknowledgement.
Same-manager reactivation can remain refused while old loads or tracked resource
work are unsafe. External fencing is still required before another process takes over.

**Migration: closed runtime handles are no longer reusable.** After ordinary
domain `close()`, the old disposed `Session` cannot be reopened or reused; it does
not forward calls to a replacement. Call `await manager.getSession(sessionId)`,
check its `Result`, then call `reopen()` on the returned fresh closed runtime and
check that result too. The current still-active tenure can do this without a new
activation. After explicit park/revoke, acquire external ownership and explicitly
activate first. This is an intentional compatibility change for retained handles.

Operation-scoped context mutation helpers expire when their operation ends. Do
not retain a ready-hook `reserveSequence` callback beyond the hook; use a fresh
method context or an explicitly tracked background lifetime instead.

The following helper assumes the host already holds ownership and has a manager:

```typescript
import type { SessionManager, SessionId } from '@roj-ai/sdk'

async function acceptAndPark(manager: SessionManager, sessionId: SessionId) {
  const activation = manager.activateSession(sessionId)
  if (!activation.ok) throw new Error(activation.error.message)

  const loaded = await manager.getSession(sessionId)
  if (!loaded.ok) throw new Error(loaded.error.message)

  const accepted = await loaded.value.callPluginMethod('user-chat.sendMessage', {
    deliveryId: 'request-42',
    content: 'Hello',
  })
  if (!accepted.ok) throw new Error(accepted.error.message)

  await manager.parkSession(activation.value)
  return accepted.value
}
```

Use a preset with `user-chat`. Release external ownership only after this helper
resolves; on failure, follow the host's fencing/recovery path instead. Parking may
wait for admitted inference. The SDK does not promise continued inference after
loss of the provider inference TCP connection or exactly-once inference. This does
not refer to a browser WebSocket disconnect, which does not itself imply an SDK inference abort.

## Durable wakes

`Scheduler` has `wake(key, delayMs): Promise<void>` (replaces that key's pending
wake) and `cancel(key): Promise<void>`. A durable adapter must resolve these only
after the corresponding durable operation is accepted. A plain `Scheduler` host
delivers due keys through `await manager.dispatchWake(key)` under current ownership.
`LiveScheduler` additionally registers `onWake(handler)`; the built-in timer
scheduler is process-local, not durable, and does not provide durable retries.

The durable host owns acknowledgement and retry. Do not acknowledge a wake when
dispatch throws, including `SessionRuntimeUnavailableError` on activation refusal;
retry against the correct owner after it can admit work. Never treat a refused
wake as completed merely because its process received it. Successful dispatch may
also mean an obsolete target or unrecognized key was ignored, not inference ran.
Graceful park waits for tracked scheduler operations and rejects on their failure.
Fence stale scheduler calls so an old owner cannot cancel or replace a new wake.

## Retryable user-chat acceptance

`user-chat.sendMessage` accepts `{ content, agentId?, deliveryId? }` and returns
`{ messageId }` in a successful `Result`. `deliveryId` is an optional nonempty
opaque string scoped to the session. Without it, calls do not deduplicate.

- A matching retry returns the original `messageId`, including after replay.
- Concurrent matching calls in one runtime share the in-flight acceptance.
- Reusing an ID with different **original** content or a different explicit
  `agentId` returns `user_chat_delivery_conflict`.
- Omitting `agentId` and explicitly supplying the resolved entry agent are
  different requests. Preserve that distinction on retries.
- The fingerprint is computed before truncation; receipts persist with the
  accepted message event, not only in process memory.

For HTTP, send `POST /rpc` with
`{ "method": "user-chat.sendMessage", "input": { "sessionId": "…", "deliveryId": "request-42", "content": "Hello" } }`.
Dispatched method results keep the existing HTTP 200 envelope:
`{ "ok": true, "value": { "messageId": "…" } }` or
`{ "ok": false, "error": { "type": "user_chat_delivery_conflict", "message": "…" } }`.
The internal conflict domain error has `httpStatus: 409`; RPC still returns HTTP
200 and includes only `type` and `message` in `error`, not `httpStatus`.
Inspect `ok`, not just HTTP status; transport errors can use other status codes.
Acceptance means the message event was committed by the configured event store.
With durable storage this is durable acceptance, not exactly-once inference or
proof of a completed reply. After an ambiguous response, retry the unchanged
request with the same ID once recovery and ownership are safe.

## File persistence contract

`FileEventStore(basePath, fs, logger?)` requires `FileSystem.rename`. This method
is optional on the general filesystem interface but mandatory for this store;
construction without it throws `FileEventStoreCapabilityError`. The adapter must
provide atomic same-directory rename, including replacement of metadata files.

Under `sessions/<sessionId>/.events/`, valid legacy `events.jsonl` remains readable
and is never appended to or rewritten by the new writer. New appends use
`batches/0000000000000000.json`, followed by contiguous hexadecimal sequence names.
Each version-1 envelope contains `version`, `batch`, `byteLength`, `sha256`, and
`payload` (a JSON string containing a nonempty event array). Recovery validates
the sequence, UTF-8, payload length/checksum, event shape, and session identity.

The writer writes `.pending-*` in the destination directory and atomically renames
it into the committed batch name. An append batch has all-or-none logical
visibility, not a partially replayable prefix. Recovery ignores pending files and
attempts their cleanup after validating committed history. Metadata is derived
from events and refreshed separately; metadata-write failure does not undo a
confirmed event commit. This protocol does **not** call fsync or guarantee survival
of power loss. It requires a single writer instance per session, not merely a
filesystem shared by several independently cached stores.

**Downgrade is unsupported after the first new batch commit.** An older SDK may
see only legacy history. Safe rollback requires a suitable pre-write backup or a
deployment that understands batches; never point an old SDK at newly written data.

## Recovery checklist

1. Stop routing new work to the affected tenure. Retain ownership for graceful
   park, or revoke locally and enforce external fencing before replacement.
2. Preserve storage and error details. `EventAppendError` means the append was
   confirmed not committed; `EventAppendOutcomeUnknownError` means it could not
   be determined. Do not blindly retry writes on an uncertain store instance.
3. After an uncertain outcome, use a **fresh event store and runtime** under safe
   single-writer ownership. Replay establishes which receipts and batches exist.
4. On `EventLogCorruptionError`, stop and investigate or restore a verified backup.
   Malformed historical legacy JSONL is not automatically repairable. Do not
   truncate history or remove committed batches to make validation pass.
5. Retry unacknowledged deliveries with the same IDs and requests; retry pending
   durable wakes against the admitted owner. Confirm receipt/history recovery
   separately from inference or external-effect completion.
