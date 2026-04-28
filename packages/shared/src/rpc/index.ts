/**
 * RPC Module - Shared re-exports for client/CLI consumers.
 */

// Client
export { BatchBuilder, type BatchEntry, RpcClient, RpcError, type RpcErrorInfo } from './client.js'

// Result types
export { Err, flatMapResult, isErr, isOk, mapResult, Ok, unwrapOr, unwrapOrThrow } from '../lib/result.js'
export type { Result } from '../lib/result.js'

// Type-only re-exports from agent-server (zero runtime cost)
export type { RpcInput, RpcMethodDef, RpcMethodName, RpcMethods, RpcOutput } from '@roj-ai/sdk/rpc'
export type { AgentChatMessage, AskUserChatMessage, ChatMessage, UserChatMessage } from '@roj-ai/sdk/rpc'
