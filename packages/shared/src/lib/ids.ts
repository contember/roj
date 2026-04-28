/**
 * Branded ID types and constructors.
 *
 * Uses Zod brands for structural compatibility with agent-server types.
 * These are the canonical definitions — other packages import from here.
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
