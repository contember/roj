# Session runtime lifetime

## Breaking change: reacquire after close

An ordinary domain close persists `session_closed` and disposes its runtime.
The old `Session` object cannot be reused, even after another runtime reopens
the same session. Its `close()`, `reopen()`, and root `callPluginMethod()` calls
return `session_runtime_unavailable` during teardown and after disposal.
Old references do not forward calls to a replacement runtime.

After awaiting close and its teardown, acquire a fresh closed runtime through
`manager.getSession(sessionId)`. Call `reopen()` or `sessions.reopen` on that
new object. The new object becomes active; the old object's state stays closed.
A freshly acquired closed runtime still exposes domain errors such as
`session_closed` when asked to close again.

Closed runtimes use the normal residency cache. Repeated reads return the same
handle until eviction, park, or revoke. Reopening promotes that cached runtime;
it does not retain an additional historical runtime.

This intentionally replaces compatibility with reopening the original object.
Callers that retain `Session` references must update their acquisition boundary.

## Explicit release

Park and revoke require explicit `activateSession(sessionId)` before a later
manager acquisition can reconstruct the runtime. Ordinary domain close does
not require a new activation. An admitted reopen that started before parking
can finish, but cannot start successor work on the parking runtime.

## Scheduler delivery

A wake refused because its runtime is unavailable rejects with
`SessionRuntimeUnavailableError`; the host must not treat it as acknowledged.
This includes delivery during teardown. A wake does not reconstruct a runtime
in the middle of idle unload. Unknown keys and genuinely missing targets may
be ignored. Delivery after ordinary idle unload can load a new runtime.

## Draining on a deadline

After stopping admission, the runtime calls `onSessionPark` hooks before waiting
for admitted operations. Plugins use this phase to quiesce background work;
`onSessionClose('parked')` performs final cleanup after those operations drain.
Park hooks may run again after a failed park and must be retryable. They receive
a teardown activity so their cleanup effects can complete during parking.

### What a drain costs

The waits below are spent in `performPark` order. The plugin bounds are separate
from the host's deadline and they add up — none of them caps the whole drain.

| Wait | Bound | Default |
|---|---|---|
| `onSessionPark` hooks | unbounded in aggregate; each plugin bounds itself | — |
| — workers finish naturally | `stopTimeoutMs` | 5 s |
| — workers are cancelled | `stopTimeoutMs` again | 5 s |
| — worker effects drain | `effectDrainTimeoutMs` | 5 s |
| Admitted operations | unbounded | — |
| The in-flight agent turn | unbounded — park does not abort it, revoke does | — |
| A write waiting for its turn | `writeQueueTimeoutMs` | 30 s |
| The in-flight append itself | unbounded | — |
| `onSessionClose('parked')` hooks | unbounded in aggregate | — |
| — each service stop hook | `hookTimeoutMs` | 30 s |
| The scheduler tail | unbounded | — |

Four of those have no bound at all: admitted operations, the in-flight agent turn
(which contains a provider request), the in-flight append, and the scheduler
tail. Tuning the knobs alone therefore cannot make a park fit a budget.

`parkSession(handle, { timeoutMs })` bounds the caller's wait, not the drain.
The park keeps running past the timeout and a later call races the same one, so
a host whose budget ran out should revoke and fall back to whatever fencing it
uses to admit the replacement.

A park that reports a failure stays retryable. The runtime does not return to
`ready`, so it still admits no new work, but the failure is reported once rather
than retained: a settled append error or a failed wake would otherwise refuse
every later handoff of that runtime. A retry re-runs both hook phases, so a
plugin's `onSessionPark` and `onSessionClose` must both be idempotent — a hook
that threw is not cached, and one that later succeeds clears the failure. A park
that found the runtime already gone rejects with `SessionRuntimeUnavailableError`
and is terminal.

Appends are serialised per session so state follows the log, which makes one
stalled write block every later one. `writeQueueTimeoutMs` bounds waiting for a
turn. A turn that never comes definitely did not commit, and the store fences,
because nothing may be ordered behind a head whose outcome is still open. A host
that drains on a deadline should keep this under its own budget.

## Losing the session to another host

Nobody can revoke a host that is merely unreachable, so an owner that lost the
session has one signal left: its own refused write. An `EventStore` bound to a
host's lease throws `SessionOwnershipLostError` once that lease moved on.

This is not a drain. The store fences, the runtime revokes itself rather than
parking — a replacement already owns the log, so there is nothing to write — and
the manager drops the residency, so the next access reloads and asks the store
who owns it now. Plugin close hooks run with reason `revoked`.
