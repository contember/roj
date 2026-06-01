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
 *
 * Alongside the `idle` status, abnormal terminal states (pause / error) also emit
 * a dedicated `agentStopped` notification carrying the pause reason / error detail,
 * so consumers (e.g. a Cloudflare worker) can alert on a budget pause or crash —
 * which the coarse `idle` status alone can't distinguish from a normal completion.
 */

import z from 'zod/v4'
import { agentIdSchema, protocolAgentStatusSchema } from '~/core/agents/schema.js'
import { definePlugin } from '~/core/plugins/index.js'
import { sessionIdSchema } from '~/core/sessions/schema.js'

/**
 * Payload for the `agentStopped` notification — emitted when an agent reaches an
 * abnormal terminal state (paused or errored), as opposed to a normal idle.
 */
export const agentStoppedNotificationSchema = z.object({
	sessionId: sessionIdSchema,
	agentId: agentIdSchema,
	definitionName: z.string().optional(),
	kind: z.enum(['paused', 'errored']),
	/** Present when kind === 'paused' — why the agent was paused. */
	reason: z.enum(['limit', 'handler', 'manual']).optional(),
	/** Human-readable detail (budget message / error message). */
	message: z.string().optional(),
	timestamp: z.number(),
})

export type AgentStoppedNotification = z.infer<typeof agentStoppedNotificationSchema>

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
	.notification('agentStopped', {
		schema: agentStoppedNotificationSchema,
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
		// Additive abnormal-terminal signal for alerting (e.g. worker crash alert).
		ctx.notify('agentStopped', {
			sessionId: ctx.sessionId,
			agentId: ctx.agentId,
			definitionName: ctx.agentState.definitionName,
			kind: 'errored',
			message: ctx.error,
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
		// Additive abnormal-terminal signal carrying the structured pause reason and
		// message. Read from agentState (set by the agent_paused reducer) rather than
		// the loosely-typed `ctx.reason`, which actually carries the message string.
		// A budget breach surfaces as reason:'handler' with the budget detail in
		// `message` (limits-guard pauses via beforeInference `{action:'pause'}`).
		ctx.notify('agentStopped', {
			sessionId: ctx.sessionId,
			agentId: ctx.agentId,
			definitionName: ctx.agentState.definitionName,
			kind: 'paused',
			reason: ctx.agentState.pauseReason,
			message: ctx.agentState.pauseMessage,
			timestamp: Date.now(),
		})
		return null
	})
	.build()
