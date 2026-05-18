/**
 * Agent Status Plugin
 *
 * Emits agentStatus notifications to connected clients whenever an agent
 * (entry or sub) becomes active or idle. Powers real-time "thinking" indicators.
 *
 * `thinking` is re-emitted on every iteration of the agent loop (inference and
 * tool exec) — idempotent on the client (`activeAgents.set(agentId, …)`) — so
 * the indicator survives sub-agent re-invocation. `onStart` would only fire
 * once per agent lifetime; sub-agents called repeatedly by an orchestrator
 * would emit `idle` (per onComplete) but never another `thinking`, leaving the
 * UI looking frozen.
 *
 * `idle` fires on `onComplete`, `onError`, and `onPause` — covers every terminal
 * state of an agent turn, including hard-limit pauses (limits-guard) and manual
 * `Session.pauseAgent` calls that would otherwise leave the indicator hung.
 */

import z from 'zod/v4'
import { agentIdSchema, protocolAgentStatusSchema } from '~/core/agents/schema.js'
import { definePlugin } from '~/core/plugins/index.js'
import { sessionIdSchema } from '~/core/sessions/schema.js'

export const agentStatusPlugin = definePlugin('agent-status')
	.notification('agentStatus', {
		schema: z.object({
			sessionId: sessionIdSchema,
			agentId: agentIdSchema,
			status: protocolAgentStatusSchema,
			definitionName: z.string().optional(),
			timestamp: z.number(),
		}),
	})
	.hook('onStart', async (ctx) => {
		ctx.notify('agentStatus', {
			sessionId: ctx.sessionId,
			agentId: ctx.agentId,
			status: 'thinking',
			definitionName: ctx.agentState.definitionName,
			timestamp: Date.now(),
		})
		return null
	})
	.hook('beforeInference', async (ctx) => {
		ctx.notify('agentStatus', {
			sessionId: ctx.sessionId,
			agentId: ctx.agentId,
			status: 'thinking',
			definitionName: ctx.agentState.definitionName,
			timestamp: Date.now(),
		})
		return null
	})
	.hook('beforeToolCall', async (ctx) => {
		ctx.notify('agentStatus', {
			sessionId: ctx.sessionId,
			agentId: ctx.agentId,
			status: 'thinking',
			definitionName: ctx.agentState.definitionName,
			timestamp: Date.now(),
		})
		return null
	})
	.hook('onComplete', async (ctx) => {
		ctx.notify('agentStatus', {
			sessionId: ctx.sessionId,
			agentId: ctx.agentId,
			status: 'idle',
			definitionName: ctx.agentState.definitionName,
			timestamp: Date.now(),
		})
		return null
	})
	.hook('onError', async (ctx) => {
		// Emit idle for both entry and sub-agents — without this the client's
		// `activeAgents` map keeps the agent flagged thinking until reconnect,
		// since the session-store no longer clears it on chat_message/ask_user.
		ctx.notify('agentStatus', {
			sessionId: ctx.sessionId,
			agentId: ctx.agentId,
			status: 'idle',
			definitionName: ctx.agentState.definitionName,
			timestamp: Date.now(),
		})
		return null
	})
	.hook('onPause', async (ctx) => {
		// Pause never reaches onComplete (e.g. limits-guard hard limit, manual
		// pauseAgent API). Without this the indicator stays "thinking" until the
		// agent is resumed.
		ctx.notify('agentStatus', {
			sessionId: ctx.sessionId,
			agentId: ctx.agentId,
			status: 'idle',
			definitionName: ctx.agentState.definitionName,
			timestamp: Date.now(),
		})
		return null
	})
	.build()
