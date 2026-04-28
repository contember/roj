/**
 * @roj-ai/client/platform
 *
 * Client SDK for the roj platform REST API. Works against both the full
 * platform (Cloudflare worker) and the standalone server.
 */

// Generic RPC framework
export { defineMethods, method } from './rpc-definition'
export type { MethodDef, MethodInput, MethodOutput, RpcRequest, RpcResponse, RpcError } from './rpc-definition'
export { createRpcClient } from './rpc-client'
export type { RpcClient, RpcClientOptions, RpcResult } from './rpc-client'
export { createRpcRouter } from './rpc-server'
export type { RpcRouter, MethodHandler, MethodHandlers } from './rpc-server'

// Platform method contracts
export { platformMethods } from './methods'
export type { PlatformMethods, PlatformMethodName } from './methods'
export type * from './methods'

export { instanceMethods } from './instance-methods'
export type { InstanceMethods, InstanceMethodName } from './instance-methods'
export type * from './instance-methods'

// Types
export type { SandboxState } from './sandbox-state'

// URL builders
export { buildPreviewUrl, buildWsUrl, buildApiBaseUrl, instanceIdToHex } from './urls'
export type { BuildPreviewUrlOptions, BuildWsUrlOptions } from './urls'

// REST client
export { createRojClient } from './rest-client'
export type { RojClient, RojClientOptions } from './rest-client'

// Errors
export { RojApiError } from './errors'
