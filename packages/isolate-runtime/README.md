# @roj-ai/isolate-runtime

Runs the Roj runtime and an app's `roj build` bundle inside a Cloudflare Durable Object, without a VM.
The host loads the code through the [Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
and runs it as a [Durable Object facet](https://developers.cloudflare.com/durable-objects/api/facets/) of its own instance object.

```
client ──► host DO (trusted)                                  facet "runtime" (loaded code, untrusted)
           authenticates, stamps `_caller`        ──fetch──►   SDK + kompjutr + app bundle
           alarm() ─────────────────────────── deliverWakes►   own SQLite: filesystem, events, LLM log, wakes
           RuntimeHost entrypoint = env.HOST      ◄──────────  setAlarm / deleteAlarm / broadcast
           egress gateway = globalOutbound        ◄──────────  every fetch: allowlist, provider key, tool credentials
```

The runtime holds no keys and no bindings. Its only capability is `env.HOST`. Every `fetch` it or the app
makes goes to the gateway the host set as `globalOutbound`, which adds the provider key and any tool
credentials. The runtime sends the placeholder `EGRESS_PROVIDED_KEY` as its OpenRouter key.

## What the host provides

| | |
|---|---|
| `env.HOST` | A `RuntimeHost` (`src/host-contract.ts`): the host DO's alarm slot and a sink for user-output notifications (`{ type, payload, ts }`, the shape the sandbox runtime sends over its agent WebSocket). |
| `globalOutbound` | The egress gateway. |
| `alarm()` | Calls `deliverWakes()` on the facet. A facet has no alarm of its own. |
| Caller | The facet serves the sandbox runtime's HTTP surface (`/rpc`, `/status`, `/sessions/*`) with no auth of its own. The host sets `_caller` on every RPC from the principal it authenticated, and drops whatever the client sent. |

`e2e/host.ts` is a complete minimal host.

## Building the modules

```ts
import { buildRuntimeModules, withAppBundle } from '@roj-ai/isolate-runtime/build'

const runtime = await buildRuntimeModules()          // once per runtime version, needs Bun
const { mainModule, modules } = withAppBundle(runtime, appBundleSource)
env.LOADER.get(`${bundleRevision}:${runtimeVersion}`, () => ({ mainModule, modules, ... }))
```

- The SDK is built once and shared by every bundle. The app bundle must be built in `externalSdk` mode (`runtime: { external: true }`). Its `@roj-ai/sdk/*` imports resolve to shim modules that re-export the shared build. Any other `@roj-ai/*` import fails at load.
- `unresolvedImports(modules)` lists imports that would not resolve under the loader's rules: a specifier resolves relative to the importing module's directory, even a bare one.
- About 3 MB raw: the SDK chunks plus a `main.js` of about 1.9 MB, which bundles kompjutr.

## Evictions

Event sourcing restores a session, not a request in flight. When a delivery starts, the scheduler arms a
retry (`inFlightRetryMs`, 5 minutes by default) and clears it when the delivery ends. If the isolate is
evicted mid-turn, the retry fires the host alarm, the facet loads its sessions again, and the SDK resets
agents left `inferring` to `pending`. The lost provider call is made again and billed twice.

## Tests

- `bun test packages/isolate-runtime/src`: scheduler, runtime on `bun:sqlite`, module build. Part of `bun run test`.
- `bun test packages/isolate-runtime/e2e`: the runtime in workerd under `wrangler dev`, with a fake provider behind the gateway. Run by hand.

Facets and the Worker Loader are in open beta. Locally they need the `experimental` compatibility flag.
