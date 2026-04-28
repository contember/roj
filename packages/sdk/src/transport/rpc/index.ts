/**
 * RPC Module
 *
 * Re-exports for type-safe RPC between agent-server and SPA client.
 */

// Chat message types (re-exported from user-chat plugin)
export type { AgentChatMessage, AskUserChatMessage, ChatMessage, UserChatMessage } from '~/plugins/user-chat/index.js'

// RPC type helpers (inferred from system composition)
export type { RpcInput, RpcMethodDef, RpcMethodName, RpcMethods, RpcOutput } from './methods.js'
