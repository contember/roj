/**
 * @roj-ai/client/platform
 *
 * Client SDK for the roj platform REST API. Works against both the full
 * platform (Cloudflare worker) and the standalone server.
 */

// Generic RPC framework
export { defineMethods, method } from './rpc-definition.js'
export type { MethodDef, MethodInput, MethodOutput, RpcRequest, RpcResponse, RpcError } from './rpc-definition.js'
export { createRpcClient } from './rpc-client.js'
export type { RpcClient, RpcClientOptions, RpcResult } from './rpc-client.js'
export { createRpcRouter } from './rpc-server.js'
export type { RpcRouter, MethodHandler, MethodHandlers } from './rpc-server.js'

// Platform method contracts
export { platformMethods } from './methods.js'
export type { PlatformMethods, PlatformMethodName } from './methods.js'
export type * from './methods.js'

export { instanceMethods } from './instance-methods.js'
export type { InstanceMethods, InstanceMethodName } from './instance-methods.js'
export type * from './instance-methods.js'

// Types
export type { SandboxState } from './sandbox-state.js'

// URL builders
export { buildPreviewUrl, buildWsUrl, buildApiBaseUrl, instanceIdToHex } from './urls.js'
export type { BuildPreviewUrlOptions, BuildWsUrlOptions } from './urls.js'

// REST client
export { createRojClient } from './rest-client.js'
export type { RojClient, RojClientOptions, SessionRpcInput } from './rest-client.js'

// Errors
export { RojApiError } from './errors.js'
