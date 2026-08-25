/**
 * Branded ID types and constructors.
 *
 * Uses Zod brands for structural compatibility with agent-server types.
 *
 * NOT canonical: @roj-ai/sdk declares its own SessionId/AgentId/ChatMessageId
 * (core/sessions/schema.ts, core/agents/schema.ts) and is the side the domain
 * vocabulary is migrating to — see sdk/src/index.ts. The brands are structural,
 * so the two sets stay assignable, but nothing asserts that they agree.
 */
import z from 'zod/v4'

const sessionIdSchema = z.string().brand('SessionId')
export type SessionId = z.infer<typeof sessionIdSchema>
export const SessionId = (id: string): SessionId => id as SessionId

const agentIdSchema = z.string().brand('AgentId')
export type AgentId = z.infer<typeof agentIdSchema>
export const AgentId = (id: string): AgentId => id as AgentId

const chatMessageIdSchema = z.string().brand('ChatMessageId')
export type ChatMessageId = z.infer<typeof chatMessageIdSchema>
export const ChatMessageId = (id: string): ChatMessageId => id as ChatMessageId

const uploadIdSchema = z.string().brand('UploadId')
export type UploadId = z.infer<typeof uploadIdSchema>
export const UploadId = (id: string): UploadId => id as UploadId
