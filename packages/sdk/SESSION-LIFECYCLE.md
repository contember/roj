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
